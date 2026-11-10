import type { DB } from './db.ts';
import type { Platform } from '../riot/regions.ts';
import type { MatchDto } from '../riot/types.ts';

export interface GuildRow { guild_id: string; log_channel_id: string | null; timezone: string; created_at: number }
export interface PlayerRow {
  puuid: string; platform: Platform; game_name: string; tag_line: string;
  last_match_check: number; last_rank_check: number; created_at: number;
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
  findPlayerByRiotId(gameName: string, tagLine: string) {
    return this.db.prepare('SELECT * FROM players WHERE lower(game_name) = lower(?) AND lower(tag_line) = lower(?)')
      .get(gameName, tagLine) as PlayerRow | undefined;
  }
  /** Players tracked by at least one guild. */
  activePlayers() {
    return this.db.prepare('SELECT p.* FROM players p WHERE EXISTS (SELECT 1 FROM tracked t WHERE t.puuid = p.puuid) ORDER BY p.created_at')
      .all() as unknown as PlayerRow[];
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
  untrack(guildId: string, puuid: string): boolean {
    const r = this.db.prepare('DELETE FROM tracked WHERE guild_id = ? AND puuid = ?').run(guildId, puuid);
    // Drop the player entirely once no guild tracks them, so we stop polling.
    this.db.prepare('DELETE FROM players WHERE puuid = ? AND NOT EXISTS (SELECT 1 FROM tracked WHERE puuid = ?)').run(puuid, puuid);
    return r.changes > 0;
  }
  trackedInGuild(guildId: string) {
    return this.db.prepare('SELECT p.* FROM players p JOIN tracked t ON t.puuid = p.puuid WHERE t.guild_id = ? ORDER BY p.game_name COLLATE NOCASE')
      .all(guildId) as unknown as PlayerRow[];
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
    this.db.prepare('INSERT OR IGNORE INTO match_cache (match_id, json, fetched_at) VALUES (?, ?, ?)')
      .run(m.metadata.matchId, JSON.stringify(m), this.now());
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

  // ---- posts / digests ----
  markPosted(guildId: string, matchId: string, puuid: string): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO posts (guild_id, match_id, puuid, posted_at) VALUES (?, ?, ?, ?)').run(guildId, matchId, puuid, this.now());
    return r.changes > 0;
  }
  markDigestRun(guildId: string, kind: 'daily' | 'weekly', periodKey: string): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO digest_runs (guild_id, kind, period_key, ran_at) VALUES (?, ?, ?, ?)').run(guildId, kind, periodKey, this.now());
    return r.changes > 0;
  }
}
