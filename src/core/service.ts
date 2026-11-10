import type { GuildRow, PlayerRow, Repo } from '../db/repo.ts';
import type { RiotClient } from '../riot/client.ts';
import { parsePlatform, PLATFORM_LABEL, type Platform } from '../riot/regions.ts';
import { formatRiotId, parseRiotId } from '../riot/riotId.ts';
import type { LeagueEntryDto } from '../riot/types.ts';
import { buildAdjustmentEmbed, buildDigestEmbed } from '../render/digestEmbed.ts';
import { buildGameEmbed } from '../render/gameEmbed.ts';
import type { Sink } from '../sinks/sink.ts';
import { computeDigest, type Digest } from './digest.ts';
import { formatRank } from './rank.ts';
import { previousDay, previousWeek, zonedParts } from './time.ts';
import type { Tracker } from './tracker.ts';

export class UserError extends Error {}

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
  ) {}

  guild(guildId: string): GuildRow {
    return this.repo.ensureGuild(guildId, this.defaultTz);
  }

  async addPlayer(guildId: string, regionInput: string, riotIdInput: string, addedBy?: string): Promise<{ player: PlayerRow; entries: LeagueEntryDto[]; alreadyTracked: boolean }> {
    const platform = parsePlatform(regionInput);
    if (!platform) throw new UserError(`Unknown region "${regionInput}". Use one of: ${Object.values(PLATFORM_LABEL).join(', ')}`);
    let id;
    try {
      id = parseRiotId(riotIdInput);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    this.guild(guildId);

    const account = await this.riot.getAccountByRiotId(platform, id.gameName, id.tagLine);
    if (!account) throw new UserError(`Riot ID ${formatRiotId(id)} not found`);

    const existing = this.repo.getPlayer(account.puuid);
    this.repo.upsertPlayer({
      puuid: account.puuid,
      platform,
      gameName: account.gameName ?? id.gameName,
      tagLine: account.tagLine ?? id.tagLine,
      lastMatchCheck: existing?.last_match_check ?? Math.floor(this.now() / 1000),
    });
    const isNew = this.repo.track(guildId, account.puuid, addedBy);
    const player = this.repo.getPlayer(account.puuid)!;

    // Baseline only for players we weren't already polling (another guild may track them).
    const entries = existing ? await this.riot.getLeagueEntries(platform, player.puuid) : await this.tracker.baseline(player);
    return { player, entries, alreadyTracked: !isNew };
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
      for (const guild of this.repo.guildsTracking(g.player.puuid)) {
        if (!this.repo.markPosted(guild.guild_id, g.match.metadata.matchId, g.player.puuid)) continue;
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
