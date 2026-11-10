import type { GuildRow, PlayerRow, Repo } from '../db/repo.ts';
import type { RiotClient } from '../riot/client.ts';
import { parsePlatform, PLATFORM_LABEL, type Platform } from '../riot/regions.ts';
import { formatRiotId, parseRiotId } from '../riot/riotId.ts';
import type { LeagueEntryDto } from '../riot/types.ts';
import { buildAdjustmentEmbed, buildDigestEmbed } from '../render/digestEmbed.ts';
import { buildGameEmbed } from '../render/gameEmbed.ts';
import type { Sink } from '../sinks/sink.ts';
import { computeDigest, playerStats, type Digest } from './digest.ts';
import { formatRank } from './rank.ts';
import { previousDay, previousWeek, thisWeek, today, zonedParts } from './time.ts';
import type { GameResult } from './events.ts';
import { QUEUE_TYPE_BY_ID } from '../riot/types.ts';
import { buildLeaderboardEmbed, buildPersonalRecapEmbed } from '../render/statsEmbeds.ts';
import type { Embed } from '../render/embed.ts';
import type { AssetSource } from '../assets/ddragon.ts';
import { championName } from '../assets/ddragon.ts';
import { performances } from './performance.ts';
import { renderScoreboard } from '../render/image/scoreboard.ts';
import { pointsFromHistory, renderLpGraph } from '../render/image/lpGraph.ts';
import { QUEUE_LABEL } from '../riot/types.ts';
import type { Tracker } from './tracker.ts';

export class UserError extends Error {}

/** A reply: embed plus optional PNG attachments referenced as attachment://<name>. */
export interface Reply { embed: Embed; files: { name: string; data: Buffer }[] }

/** If the bot was down at midnight, still post the digest if we come back within this window. */
const DIGEST_CATCHUP_HOURS = 6;

/**
 * Glue between storage, Riot, tracker and the output sink. Discord slash commands
 * will call these methods 1:1 (/track add -> addPlayer, etc.).
 */
export class Service {
  constructor(
    private readonly repo: Repo,
    private readonly riot: RiotClient,
    private readonly tracker: Tracker,
    private readonly sink: Sink,
    private readonly defaultTz: string,
    private readonly log: (msg: string) => void = console.log,
    private readonly now: () => number = Date.now,
    private readonly assets: AssetSource | null = null,
  ) {}

  guild(guildId: string): GuildRow {
    return this.repo.ensureGuild(guildId, this.defaultTz);
  }

  /**
   * Resolve region + "Name#TAG" to a stored player. New players get a rank baseline;
   * `register` runs before baselining so the player is in the poll set (tracked/linked).
   */
  private async resolvePlayer(regionInput: string, riotIdInput: string, register: (puuid: string) => boolean) {
    const platform = parsePlatform(regionInput);
    if (!platform) throw new UserError(`Unknown region "${regionInput}". Use one of: ${Object.values(PLATFORM_LABEL).join(', ')}`);
    let id;
    try {
      id = parseRiotId(riotIdInput);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    const account = await this.riot.getAccountByRiotId(platform, id.gameName, id.tagLine);
    if (!account) throw new UserError(`Riot ID **${formatRiotId(id)}** not found`);

    const existing = this.repo.getPlayer(account.puuid);
    this.repo.upsertPlayer({
      puuid: account.puuid,
      platform,
      gameName: account.gameName ?? id.gameName,
      tagLine: account.tagLine ?? id.tagLine,
      lastMatchCheck: existing?.last_match_check ?? Math.floor(this.now() / 1000),
    });
    const changed = register(account.puuid);
    const player = this.repo.getPlayer(account.puuid)!;
    // Only baseline players we weren't already polling; otherwise the snapshot is the live one.
    const entries = existing ? await this.riot.getLeagueEntries(platform, player.puuid) : await this.tracker.baseline(player);
    if (!entries.length) {
      // Wrong region is the common mistake: account exists globally, but no ranked data on this shard.
      const games = await this.riot.getMatchIds(platform, player.puuid, { count: 1 });
      if (!games.length) this.log(`warn: ${player.game_name}#${player.tag_line} has no ranked entries or games on ${platform}`);
    }
    return { player, entries, changed };
  }

  async addPlayer(guildId: string, regionInput: string, riotIdInput: string, addedBy?: string): Promise<{ player: PlayerRow; entries: LeagueEntryDto[]; alreadyTracked: boolean }> {
    this.guild(guildId);
    const r = await this.resolvePlayer(regionInput, riotIdInput, (puuid) => this.repo.track(guildId, puuid, addedBy));
    return { player: r.player, entries: r.entries, alreadyTracked: !r.changed };
  }

  async linkUser(discordUserId: string, regionInput: string, riotIdInput: string): Promise<{ player: PlayerRow; entries: LeagueEntryDto[]; previous: PlayerRow | null }> {
    const prevLink = this.repo.linkedPlayer(discordUserId) ?? null;
    const r = await this.resolvePlayer(regionInput, riotIdInput, (puuid) => {
      this.repo.link(discordUserId, puuid);
      return true;
    });
    return { player: r.player, entries: r.entries, previous: prevLink && prevLink.puuid !== r.player.puuid ? prevLink : null };
  }

  unlinkUser(discordUserId: string): PlayerRow {
    const p = this.repo.unlink(discordUserId);
    if (!p) throw new UserError('You have no linked account.');
    return p;
  }

  /** The account a command should act on: the given Discord user's link (or the caller's). */
  linkedOrThrow(discordUserId: string, isSelf: boolean, style = '/'): PlayerRow {
    const p = this.repo.linkedPlayer(discordUserId);
    if (!p) throw new UserError(isSelf ? `You have no linked account. Use \`${style}link\` first.` : 'That user has no linked account.');
    return p;
  }

  /** Most recent game of any queue, with LP if the tracker resolved it. */
  async recent(player: PlayerRow): Promise<Reply> {
    const [id] = await this.riot.getMatchIds(player.platform, player.puuid, { count: 1 });
    if (!id) throw new UserError(`No games found for **${player.game_name}#${player.tag_line}**.`);
    const match = this.repo.getCachedMatch(id) ?? (await this.riot.getMatch(player.platform, id));
    if (!match) throw new UserError('Could not load that match from Riot, try again in a bit.');
    this.repo.cacheMatch(match);

    const me = match.info.participants.find((p) => p.puuid === player.puuid)!;
    const pm = this.repo.getPlayerMatch(id, player.puuid);
    const qt = QUEUE_TYPE_BY_ID[match.info.queueId];
    const snap = qt ? this.repo.getSnapshot(player.puuid, qt) : undefined;
    const remake = me.gameEndedInEarlySurrender;

    const r: GameResult = {
      player, match, queueId: match.info.queueId, win: me.win, remake,
      lpDelta: null, note: null, rankBefore: null, rankAfter: snap ? { tier: snap.tier, division: snap.division, lp: snap.lp } : null,
    };
    if (pm?.status === 'done') {
      r.lpDelta = pm.lp_delta;
      r.note = (pm.note as GameResult['note']) ?? null;
      if (pm.tier_after) r.rankAfter = { tier: pm.tier_after, division: pm.div_after ?? '', lp: pm.lp_after ?? 0 };
      if (r.note === 'batched') r.batchSize = 2; // exact size isn't stored; wording only
    } else if (pm?.status === 'pending') {
      r.note = 'pending';
    } else {
      r.note = qt ? 'unrecorded' : 'norank';
    }
    return this.gameReply(r);
  }

  /**
   * Game embed with the rendered scoreboard image. Falls back to the text
   * scoreboard if rendering fails (missing native module, bad data…).
   */
  async gameReply(r: GameResult, alsoTracked: Set<string> = new Set()): Promise<Reply> {
    const sd = this.assets ? await this.assets.staticData(r.match.info.gameVersion).catch(() => null) : null;
    const self = r.match.info.participants.find((p) => p.puuid === r.player.puuid)!;
    const display = championName(sd, self.championId, self.championName);
    const badge = r.remake ? null : performances(r.match).get(r.player.puuid)?.badge ?? null;

    if (this.assets) {
      try {
        const png = await renderScoreboard(r.match, this.assets, { focus: r.player.puuid, alsoTracked });
        const embed = buildGameEmbed(r, alsoTracked, { compact: true, championDisplay: display, badge });
        embed.image = { url: 'attachment://scoreboard.png' };
        if (sd) embed.thumbnail = { url: this.assets.championUrl(sd, self.championId, self.championName) };
        const rank = r.rankAfter ?? r.rankBefore;
        const emblem = rank ? await this.assets.emblemUrl(rank.tier).catch(() => null) : null;
        if (emblem && embed.author) embed.author.icon_url = emblem;
        return { embed, files: [{ name: 'scoreboard.png', data: png }] };
      } catch (e) {
        this.log(`scoreboard render failed, using text: ${(e as Error).message}`);
      }
    }
    return { embed: buildGameEmbed(r, alsoTracked, { championDisplay: display, badge }), files: [] };
  }

  /** LP graph for the last `games` recorded games in a queue. */
  async graph(player: PlayerRow, queueId: number, games: number, tz = this.defaultTz): Promise<Reply> {
    const rows = this.repo.lpHistory(player.puuid, queueId, games);
    const pts = pointsFromHistory(rows);
    if (pts.length < 2) {
      throw new UserError(`Not enough recorded ${QUEUE_LABEL[queueId] ?? ''} games for **${player.game_name}#${player.tag_line}** yet. The graph fills up as games are played while linked/tracked.`);
    }
    const png = renderLpGraph(pts, { name: `${player.game_name}#${player.tag_line}`, queueLabel: QUEUE_LABEL[queueId] ?? `Queue ${queueId}`, tz, results: rows.map((r) => !!r.win) });
    const net = pts[pts.length - 1]!.abs - pts[0]!.abs;
    return {
      embed: {
        color: net > 0 ? 0x2ecc71 : net < 0 ? 0xe74c3c : 0x5865f2,
        image: { url: 'attachment://lp-graph.png' },
        footer: { text: rows.length < games ? `Only ${rows.length} game${rows.length === 1 ? '' : 's'} recorded so far` : `Last ${rows.length} games` },
      },
      files: [{ name: 'lp-graph.png', data: png }],
    };
  }

  personalRecap(player: PlayerRow, kind: 'daily' | 'weekly', tz = this.defaultTz): Embed {
    const period = kind === 'daily' ? today(this.now(), tz) : thisWeek(this.now(), tz);
    const stats = playerStats(this.repo, player, period);
    const rows = this.repo.doneMatchesBetween(player.puuid, period.from, period.to).reverse();
    return buildPersonalRecapEmbed({
      player,
      periodLabel: kind === 'daily' ? 'Today' : 'This week',
      stats,
      games: rows.map((row) => ({ row, match: this.repo.getCachedMatch(row.match_id) })),
      pending: this.repo.pendingMatches(player.puuid).length,
    });
  }

  leaderboard(guildId: string, kind: 'daily' | 'weekly'): Embed {
    const g = this.guild(guildId);
    const period = kind === 'daily' ? today(this.now(), g.timezone) : thisWeek(this.now(), g.timezone);
    const d = computeDigest(this.repo, guildId, 'adhoc', period);
    return buildLeaderboardEmbed(d, kind === 'daily' ? 'Leaderboard · Today' : 'Leaderboard · This week');
  }

  /** Remove by puuid (used by autocomplete-backed /track remove). */
  removeTracked(guildId: string, puuid: string): PlayerRow {
    const p = this.repo.trackedInGuild(guildId).find((x) => x.puuid === puuid);
    if (!p) throw new UserError('That account is not tracked in this server.');
    this.repo.untrack(guildId, puuid);
    return p;
  }

  setTimezone(guildId: string, tz: string) {
    this.guild(guildId);
    this.repo.setGuildTimezone(guildId, tz);
  }

  removePlayer(guildId: string, riotIdInput: string): PlayerRow {
    const id = parseRiotId(riotIdInput);
    const p = this.repo.trackedInGuild(guildId).find((x) => x.game_name.toLowerCase() === id.gameName.toLowerCase() && x.tag_line.toLowerCase() === id.tagLine.toLowerCase());
    if (!p) throw new UserError(`${formatRiotId(id)} is not tracked in this server`);
    this.repo.untrack(guildId, p.puuid);
    return p;
  }

  listPlayers(guildId: string) {
    return this.repo.trackedInGuild(guildId).map((p) => ({
      player: p,
      ranks: this.repo.getSnapshots(p.puuid).map((s) => ({ queue: s.queue_type, rank: formatRank(s) })),
    }));
  }

  /** One poll pass + fan-out of results to every guild tracking each player. */
  async tick(): Promise<{ games: number; requests: number }> {
    const { games, adjustments, requests } = await this.tracker.tick();
    for (const g of games) {
      const guilds = this.repo.guildsTracking(g.player.puuid);
      // Linked-only players have no guild; still surface them to the sink under a pseudo-guild.
      if (!guilds.length) guilds.push({ guild_id: 'linked', log_channel_id: null, timezone: this.defaultTz, created_at: 0 });
      for (const guild of guilds) {
        if (guild.guild_id !== 'linked' && !this.repo.markPosted(guild.guild_id, g.match.metadata.matchId, g.player.puuid)) continue;
        const others = new Set(this.repo.trackedInGuild(guild.guild_id).map((p) => p.puuid).filter((x) => x !== g.player.puuid));
        await this.sink.send(guild, 'game', [buildGameEmbed(g, others)], { label: `${g.match.metadata.matchId}-${g.player.game_name}` });
      }
    }
    for (const a of adjustments) {
      for (const guild of this.repo.guildsTracking(a.player.puuid)) {
        await this.sink.send(guild, 'notice', [buildAdjustmentEmbed(a.player.game_name, a.queueType, a.delta, formatRank(a.rankBefore), formatRank(a.rankAfter))], { label: `adj-${a.player.game_name}` });
      }
    }
    return { games: games.length, requests };
  }

  digest(guildId: string, kind: 'daily' | 'weekly'): Digest {
    const g = this.guild(guildId);
    const period = kind === 'daily' ? previousDay(this.now(), g.timezone) : previousWeek(this.now(), g.timezone);
    return computeDigest(this.repo, guildId, kind, period);
  }

  async postDigest(guildId: string, kind: 'daily' | 'weekly'): Promise<void> {
    const d = this.digest(guildId, kind);
    await this.sink.send(this.guild(guildId), 'digest', [buildDigestEmbed(d)], { label: `${kind}-${d.period.key}` });
  }

  /**
   * Called every minute. For each guild, if it's past local midnight and the
   * previous day's (and on Mondays, week's) digest hasn't run, run it once.
   */
  async runDueDigests(): Promise<void> {
    for (const g of this.repo.listGuilds()) {
      const local = zonedParts(this.now(), g.timezone);
      if (local.hour >= DIGEST_CATCHUP_HOURS) continue;
      const day = previousDay(this.now(), g.timezone);
      if (this.repo.markDigestRun(g.guild_id, 'daily', day.key)) {
        this.log(`[${g.guild_id}] daily digest ${day.key}`);
        await this.sink.send(g, 'digest', [buildDigestEmbed(computeDigest(this.repo, g.guild_id, 'daily', day))], { label: `daily-${day.key}` });
      }
      if (local.weekday === 1) {
        const wk = previousWeek(this.now(), g.timezone);
        if (this.repo.markDigestRun(g.guild_id, 'weekly', wk.key)) {
          this.log(`[${g.guild_id}] weekly digest ${wk.key}`);
          await this.sink.send(g, 'digest', [buildDigestEmbed(computeDigest(this.repo, g.guild_id, 'weekly', wk))], { label: `weekly-${wk.key}` });
        }
      }
    }
  }

  /** Refresh Riot IDs (players rename). Cheap: one account-v1 call per player. */
  async refreshNames(): Promise<number> {
    let changed = 0;
    for (const p of this.repo.activePlayers()) {
      const a = await this.riot.getAccountByPuuid(p.platform as Platform, p.puuid);
      if (a?.gameName && a.tagLine && (a.gameName !== p.game_name || a.tagLine !== p.tag_line)) {
        this.log(`rename: ${p.game_name}#${p.tag_line} -> ${a.gameName}#${a.tagLine}`);
        this.repo.renamePlayer(p.puuid, a.gameName, a.tagLine);
        changed++;
      }
    }
    return changed;
  }
}
