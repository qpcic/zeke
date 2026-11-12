import type { DB } from './db.ts';
import type { Platform } from '../riot/regions.ts';
import type { MatchDto } from '../riot/types.ts';

export interface GuildRow {
  guild_id: string; log_channel_id: string | null; timezone: string; created_at: number;
  recap_channel_id: string | null; recap_posted_to: number;
}
export interface PlayerRow {
  puuid: string; platform: Platform; game_name: string; tag_line: string;
  last_match_check: number; last_rank_check: number; created_at: number;
  next_poll_at: number; last_game_at: number;
}
export interface SnapshotRow {
  puuid: string; queue_type: string; tier: string; division: string; lp: number; wins: number; losses: number; taken_at: number;
}
export type MatchStatus = 'pending' | 'done' | 'ignored';
export interface PlayerMatchRow {
  match_id: string; puuid: string; queue_id: number; status: MatchStatus; win: number; remake: number;
  game_end: number; first_seen: number; lp_delta: number | null; note: string | null;
  tier_after: string | null; div_after: string | null; lp_after: number | null; finalized_at: number | null;
}

/** Thin typed wrapper over prepared statements. */
export class Repo {
  constructor(readonly db: DB, private readonly now: () => number = Date.now) {}

  // ---- guilds ----
  ensureGuild(guildId: string, timezone: string): GuildRow {
    this.db.prepare('INSERT OR IGNORE INTO guilds (guild_id, timezone, created_at) VALUES (?, ?, ?)').run(guildId, timezone, this.now());
    return this.getGuild(guildId)!;
  }
  getGuild(guildId: string) {
    return this.db.prepare('SELECT * FROM guilds WHERE guild_id = ?').get(guildId) as GuildRow | undefined;
  }
  listGuilds() {
    return this.db.prepare('SELECT * FROM guilds').all() as unknown as GuildRow[];
  }
  setGuildChannel(guildId: string, channelId: string | null) {
    this.db.prepare('UPDATE guilds SET log_channel_id = ? WHERE guild_id = ?').run(channelId, guildId);
  }
  setGuildTimezone(guildId: string, tz: string) {
    this.db.prepare('UPDATE guilds SET timezone = ? WHERE guild_id = ?').run(tz, guildId);
  }

  // ---- players / tracking ----
  upsertPlayer(p: { puuid: string; platform: Platform; gameName: string; tagLine: string; lastMatchCheck: number }) {
    this.db.prepare(`
      INSERT INTO players (puuid, platform, game_name, tag_line, last_match_check, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(puuid) DO UPDATE SET platform = excluded.platform, game_name = excluded.game_name, tag_line = excluded.tag_line
    `).run(p.puuid, p.platform, p.gameName, p.tagLine, p.lastMatchCheck, this.now());
  }
  getPlayer(puuid: string) {
    return this.db.prepare('SELECT * FROM players WHERE puuid = ?').get(puuid) as PlayerRow | undefined;
  }
  /** Case-insensitive Riot ID lookup; Riot IDs are globally unique, platform only narrows it. */
  findPlayerByRiotId(gameName: string, tagLine: string, platform?: string) {
    return this.db.prepare(`
      SELECT * FROM players WHERE lower(game_name) = lower(?) AND lower(tag_line) = lower(?) AND (? IS NULL OR platform = ?)
      ORDER BY created_at LIMIT 1
    `).get(gameName, tagLine, platform ?? null, platform ?? null) as PlayerRow | undefined;
  }
  /** Every known player. Players are global: once added (any server, link or lookup) they stay tracked. */
  /** Discord users with at least one linked account. */
  linkedUserCount(): number {
    return (this.db.prepare('SELECT COUNT(DISTINCT discord_user_id) AS n FROM links').get() as { n: number }).n;
  }
  activePlayers() {
    return this.db.prepare('SELECT * FROM players ORDER BY created_at').all() as unknown as PlayerRow[];
  }
  /** Players whose next poll is due. */
  duePlayers(nowMs: number) {
    return this.db.prepare('SELECT * FROM players WHERE next_poll_at <= ? ORDER BY next_poll_at, created_at').all(nowMs) as unknown as PlayerRow[];
  }
  /** Linked by someone or on a server leaderboard. */
  isAnchored(puuid: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM tracked WHERE puuid = ? UNION SELECT 1 FROM links WHERE puuid = ? LIMIT 1').get(puuid, puuid);
  }
  setNextPoll(puuid: string, ms: number) {
    this.db.prepare('UPDATE players SET next_poll_at = ? WHERE puuid = ?').run(ms, puuid);
  }
  bumpLastGame(puuid: string, gameEndMs: number) {
    this.db.prepare('UPDATE players SET last_game_at = MAX(last_game_at, ?) WHERE puuid = ?').run(gameEndMs, puuid);
  }
  renamePlayer(puuid: string, gameName: string, tagLine: string) {
    this.db.prepare('UPDATE players SET game_name = ?, tag_line = ? WHERE puuid = ?').run(gameName, tagLine, puuid);
  }
  setLastMatchCheck(puuid: string, epochSec: number) {
    this.db.prepare('UPDATE players SET last_match_check = ? WHERE puuid = ?').run(epochSec, puuid);
  }
  setLastRankCheck(puuid: string, ms: number) {
    this.db.prepare('UPDATE players SET last_rank_check = ? WHERE puuid = ?').run(ms, puuid);
  }

  track(guildId: string, puuid: string, addedBy?: string): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO tracked (guild_id, puuid, added_by, added_at) VALUES (?, ?, ?, ?)')
      .run(guildId, puuid, addedBy ?? null, this.now());
    return r.changes > 0;
  }
  /** Removes the account from this server's leaderboard only; the player and their history stay. */
  untrack(guildId: string, puuid: string): boolean {
    const r = this.db.prepare('DELETE FROM tracked WHERE guild_id = ? AND puuid = ?').run(guildId, puuid);
    return r.changes > 0;
  }

  // ---- links (several accounts per Discord user, one main) ----
  /** Link an account. The first one becomes main. */
  link(discordUserId: string, puuid: string): { added: boolean; isMain: boolean } {
    const existing = this.db.prepare('SELECT is_main FROM links WHERE discord_user_id = ? AND puuid = ?').get(discordUserId, puuid) as { is_main: number } | undefined;
    if (existing) return { added: false, isMain: !!existing.is_main };
    const isMain = !this.getLink(discordUserId);
    this.db.prepare('INSERT INTO links (discord_user_id, puuid, is_main, linked_at) VALUES (?, ?, ?, ?)').run(discordUserId, puuid, isMain ? 1 : 0, this.now());
    return { added: true, isMain };
  }
  /** Remove one link. If it was the main, the oldest remaining account becomes main. */
  unlink(discordUserId: string, puuid: string): { player: PlayerRow; newMain: PlayerRow | null } | null {
    const row = this.db.prepare('SELECT is_main FROM links WHERE discord_user_id = ? AND puuid = ?').get(discordUserId, puuid) as { is_main: number } | undefined;
    if (!row) return null;
    const player = this.getPlayer(puuid)!;
    this.db.prepare('DELETE FROM links WHERE discord_user_id = ? AND puuid = ?').run(discordUserId, puuid);
    let newMain: PlayerRow | null = null;
    if (row.is_main) {
      const next = this.db.prepare('SELECT puuid FROM links WHERE discord_user_id = ? ORDER BY linked_at, rowid LIMIT 1').get(discordUserId) as { puuid: string } | undefined;
      if (next) {
        this.setMainLink(discordUserId, next.puuid);
        newMain = this.getPlayer(next.puuid) ?? null;
      }
    }
    return { player, newMain };
  }
  setMainLink(discordUserId: string, puuid: string): boolean {
    if (!this.db.prepare('SELECT 1 FROM links WHERE discord_user_id = ? AND puuid = ?').get(discordUserId, puuid)) return false;
    this.db.prepare('UPDATE links SET is_main = CASE WHEN puuid = ? THEN 1 ELSE 0 END WHERE discord_user_id = ?').run(puuid, discordUserId);
    return true;
  }
  /** The main link (falls back to the oldest if none is flagged). */
  getLink(discordUserId: string) {
    return this.db.prepare('SELECT * FROM links WHERE discord_user_id = ? ORDER BY is_main DESC, linked_at, rowid LIMIT 1').get(discordUserId) as
      { discord_user_id: string; puuid: string; is_main: number; linked_at: number } | undefined;
  }
  /** Main linked account: used for @mentions and stats commands. */
  linkedPlayer(discordUserId: string): PlayerRow | undefined {
    const l = this.getLink(discordUserId);
    return l ? this.getPlayer(l.puuid) : undefined;
  }
  /** All linked accounts, main first, then in the order they were added. */
  linkedPlayers(discordUserId: string): (PlayerRow & { is_main: number; linked_at: number })[] {
    return this.db.prepare(`
      SELECT p.*, l.is_main, l.linked_at FROM players p JOIN links l ON l.puuid = p.puuid
      WHERE l.discord_user_id = ? ORDER BY l.is_main DESC, l.linked_at, l.rowid
    `).all(discordUserId) as unknown as (PlayerRow & { is_main: number; linked_at: number })[];
  }
  trackedInGuild(guildId: string) {
    return this.db.prepare('SELECT p.* FROM players p JOIN tracked t ON t.puuid = p.puuid WHERE t.guild_id = ? ORDER BY p.game_name COLLATE NOCASE')
      .all(guildId) as unknown as PlayerRow[];
  }
  /** Set (or clear with null) the daily recap channel; postedTo marks days already covered. */
  setRecapChannel(guildId: string, channelId: string | null, postedTo: number) {
    this.db.prepare('UPDATE guilds SET recap_channel_id = ?, recap_posted_to = ? WHERE guild_id = ?').run(channelId, postedTo, guildId);
  }
  markRecapPosted(guildId: string, to: number) {
    this.db.prepare('UPDATE guilds SET recap_posted_to = ? WHERE guild_id = ?').run(to, guildId);
  }
  recapGuilds(): GuildRow[] {
    return this.db.prepare('SELECT * FROM guilds WHERE recap_channel_id IS NOT NULL').all() as unknown as GuildRow[];
  }

  guildsTracking(puuid: string) {
    return this.db.prepare('SELECT g.* FROM guilds g JOIN tracked t ON t.guild_id = g.guild_id WHERE t.puuid = ?')
      .all(puuid) as unknown as GuildRow[];
  }

  // ---- rank snapshots ----
  getSnapshot(puuid: string, queueType: string) {
    return this.db.prepare('SELECT * FROM rank_snapshots WHERE puuid = ? AND queue_type = ?').get(puuid, queueType) as SnapshotRow | undefined;
  }
  getSnapshots(puuid: string) {
    return this.db.prepare('SELECT * FROM rank_snapshots WHERE puuid = ?').all(puuid) as unknown as SnapshotRow[];
  }
  deleteSnapshots(queueType: string) {
    this.db.prepare('DELETE FROM rank_snapshots WHERE queue_type = ?').run(queueType);
  }
  putSnapshot(s: SnapshotRow) {
    this.db.prepare(`
      INSERT INTO rank_snapshots (puuid, queue_type, tier, division, lp, wins, losses, taken_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(puuid, queue_type) DO UPDATE SET tier = excluded.tier, division = excluded.division, lp = excluded.lp,
        wins = excluded.wins, losses = excluded.losses, taken_at = excluded.taken_at
    `).run(s.puuid, s.queue_type, s.tier, s.division, s.lp, s.wins, s.losses, s.taken_at);
  }

  // ---- matches ----
  getCachedMatch(matchId: string): MatchDto | null {
    const r = this.db.prepare('SELECT json FROM match_cache WHERE match_id = ?').get(matchId) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as MatchDto) : null;
  }
  cacheMatch(m: MatchDto) {
    this.db.prepare('INSERT INTO match_cache (match_id, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(match_id) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at')
      .run(m.metadata.matchId, JSON.stringify(m), this.now());
  }
  /** Cached match only if fetched at/after `since` (older copies carry PUUIDs from a previous API key). */
  getCachedMatchSince(matchId: string, since: number): MatchDto | null {
    const r = this.db.prepare('SELECT json FROM match_cache WHERE match_id = ? AND fetched_at >= ?').get(matchId, since) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as MatchDto) : null;
  }

  /**
   * Move everything from an old PUUID to a new one (API key changed, so Riot re-encrypted it).
   * Works whether or not a row for the new PUUID already exists (then they're merged).
   */
  rekeyPlayer(oldPuuid: string, newPuuid: string) {
    if (oldPuuid === newPuuid) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO players (puuid, platform, game_name, tag_line, last_match_check, last_rank_check, created_at, next_poll_at, last_game_at)
        SELECT ?, platform, game_name, tag_line, last_match_check, last_rank_check, created_at, 0, last_game_at FROM players WHERE puuid = ?
      `).run(newPuuid, oldPuuid);
      for (const t of ['tracked', 'links', 'rank_snapshots', 'player_matches', 'lp_events', 'posts']) {
        this.db.prepare(`UPDATE OR IGNORE ${t} SET puuid = ? WHERE puuid = ?`).run(newPuuid, oldPuuid);
        this.db.prepare(`DELETE FROM ${t} WHERE puuid = ?`).run(oldPuuid); // leftovers that collided with existing rows
      }
      // cached matches: point this player's participant entry at the new id
      this.db.prepare("UPDATE match_cache SET json = replace(json, ?, ?) WHERE instr(json, ?) > 0").run(oldPuuid, newPuuid, oldPuuid);
      this.db.prepare('DELETE FROM players WHERE puuid = ?').run(oldPuuid);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  knownMatchIds(puuid: string, ids: string[]): Set<string> {
    if (!ids.length) return new Set();
    const ph = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT match_id FROM player_matches WHERE puuid = ? AND match_id IN (${ph})`)
      .all(puuid, ...ids) as { match_id: string }[];
    return new Set(rows.map((r) => r.match_id));
  }
  insertPlayerMatch(r: Pick<PlayerMatchRow, 'match_id' | 'puuid' | 'queue_id' | 'status' | 'win' | 'remake' | 'game_end'>) {
    this.db.prepare(`
      INSERT OR IGNORE INTO player_matches (match_id, puuid, queue_id, status, win, remake, game_end, first_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(r.match_id, r.puuid, r.queue_id, r.status, r.win, r.remake, r.game_end, this.now());
  }
  pendingMatches(puuid: string) {
    return this.db.prepare("SELECT * FROM player_matches WHERE puuid = ? AND status = 'pending' ORDER BY game_end")
      .all(puuid) as unknown as PlayerMatchRow[];
  }
  finalizeMatch(matchId: string, puuid: string, f: { lpDelta: number | null; note: string | null; tier?: string; division?: string; lp?: number }) {
    this.db.prepare(`
      UPDATE player_matches SET status = 'done', lp_delta = ?, note = ?, tier_after = ?, div_after = ?, lp_after = ?, finalized_at = ?
      WHERE match_id = ? AND puuid = ?
    `).run(f.lpDelta, f.note, f.tier ?? null, f.division ?? null, f.lp ?? null, this.now(), matchId, puuid);
  }
  getPlayerMatch(matchId: string, puuid: string) {
    return this.db.prepare('SELECT * FROM player_matches WHERE match_id = ? AND puuid = ?').get(matchId, puuid) as PlayerMatchRow | undefined;
  }
  /** Resolved games with a known post-game rank for one queue, oldest first (last `limit`). */
  lpHistory(puuid: string, queueId: number, limit: number) {
    return (this.db.prepare(`
      SELECT * FROM player_matches
      WHERE puuid = ? AND queue_id = ? AND status = 'done' AND remake = 0
      ORDER BY game_end DESC LIMIT ?
    `).all(puuid, queueId, limit) as unknown as PlayerMatchRow[]).reverse();
  }
  latestDoneMatches(puuid: string, limit: number) {
    return this.db.prepare("SELECT * FROM player_matches WHERE puuid = ? AND status = 'done' ORDER BY game_end DESC LIMIT ?")
      .all(puuid, limit) as unknown as PlayerMatchRow[];
  }
  doneMatchesBetween(puuid: string, fromMs: number, toMs: number) {
    return this.db.prepare("SELECT * FROM player_matches WHERE puuid = ? AND status = 'done' AND game_end >= ? AND game_end < ? ORDER BY game_end")
      .all(puuid, fromMs, toMs) as unknown as PlayerMatchRow[];
  }

  // ---- lp events ----
  addLpEvent(e: { puuid: string; queueType: string; delta: number; kind: 'game' | 'adjustment'; matchId?: string | null; at: number }) {
    this.db.prepare('INSERT INTO lp_events (puuid, queue_type, delta, kind, match_id, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.puuid, e.queueType, e.delta, e.kind, e.matchId ?? null, e.at);
  }
  lpEventsBetween(puuid: string, fromMs: number, toMs: number) {
    return this.db.prepare('SELECT * FROM lp_events WHERE puuid = ? AND at >= ? AND at < ? ORDER BY at')
      .all(puuid, fromMs, toMs) as unknown as { queue_type: string; delta: number; kind: string; match_id: string | null; at: number }[];
  }

  // ---- admin ----
  /** Every player with how many Discord links, servers and recorded games they have. */
  playerOverview() {
    return this.db.prepare(`
      SELECT p.puuid, p.game_name, p.tag_line, p.platform, p.created_at, p.last_game_at,
        (SELECT COUNT(*) FROM links l WHERE l.puuid = p.puuid) AS links,
        (SELECT COUNT(*) FROM tracked t WHERE t.puuid = p.puuid) AS servers,
        (SELECT COUNT(*) FROM player_matches m WHERE m.puuid = p.puuid AND m.status = 'done') AS games
      FROM players p ORDER BY games DESC, p.game_name COLLATE NOCASE
    `).all() as unknown as { puuid: string; game_name: string; tag_line: string; platform: string; created_at: number; last_game_at: number; links: number; servers: number; games: number }[];
  }
  allLinks() {
    return this.db.prepare(`
      SELECT l.discord_user_id, l.linked_at, l.is_main, p.game_name, p.tag_line, p.platform
      FROM links l JOIN players p ON p.puuid = l.puuid ORDER BY l.linked_at
    `).all() as unknown as { discord_user_id: string; linked_at: number; is_main: number; game_name: string; tag_line: string; platform: string }[];
  }
  /** Rows that purgePlayer would delete. */
  playerFootprint(puuid: string) {
    const n = (sql: string) => (this.db.prepare(sql).get(puuid) as { n: number }).n;
    return {
      games: n("SELECT COUNT(*) AS n FROM player_matches WHERE puuid = ?"),
      lpEvents: n('SELECT COUNT(*) AS n FROM lp_events WHERE puuid = ?'),
      links: n('SELECT COUNT(*) AS n FROM links WHERE puuid = ?'),
      servers: n('SELECT COUNT(*) AS n FROM tracked WHERE puuid = ?'),
    };
  }
  /** Delete a player completely: games, LP history, ranks, links, server tracks; polling stops. */
  purgePlayer(puuid: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const t of ['player_matches', 'lp_events', 'rank_snapshots', 'links', 'tracked', 'posts']) {
        this.db.prepare(`DELETE FROM ${t} WHERE puuid = ?`).run(puuid);
      }
      this.db.prepare('DELETE FROM players WHERE puuid = ?').run(puuid);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---- user prefs ----
  getDefaultQueue(discordUserId: string): number | null {
    return (this.db.prepare('SELECT default_queue FROM user_prefs WHERE discord_user_id = ?').get(discordUserId) as { default_queue: number } | undefined)?.default_queue ?? null;
  }
  setDefaultQueue(discordUserId: string, queueId: number) {
    this.db.prepare(`
      INSERT INTO user_prefs (discord_user_id, default_queue, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(discord_user_id) DO UPDATE SET default_queue = excluded.default_queue, updated_at = excluded.updated_at
    `).run(discordUserId, queueId, this.now());
  }

  // ---- kv ----
  getKv(key: string): string | null {
    return (this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }
  setKv(key: string, value: string) {
    this.db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, value, this.now());
  }

  // ---- posts / digests ----
  isPosted(guildId: string, matchId: string, puuid: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM posts WHERE guild_id = ? AND match_id = ? AND puuid = ?').get(guildId, matchId, puuid);
  }
  markPosted(guildId: string, matchId: string, puuid: string): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO posts (guild_id, match_id, puuid, posted_at) VALUES (?, ?, ?, ?)').run(guildId, matchId, puuid, this.now());
    return r.changes > 0;
  }
  markDigestRun(guildId: string, kind: 'daily' | 'weekly', periodKey: string): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO digest_runs (guild_id, kind, period_key, ran_at) VALUES (?, ?, ?, ?)').run(guildId, kind, periodKey, this.now());
    return r.changes > 0;
  }
}
