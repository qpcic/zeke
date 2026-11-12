import { signed } from '../render/format.ts';
import type { GuildRow, PlayerRow, Repo } from '../db/repo.ts';
import { isStalePuuidError, type RiotClient } from '../riot/client.ts';
import { parsePlatform, PLATFORM_LABEL, type Platform } from '../riot/regions.ts';
import { formatRiotId, parseRiotId } from '../riot/riotId.ts';
import type { LeagueEntryDto } from '../riot/types.ts';
import { buildAdjustmentEmbed, buildDigestEmbed } from '../render/digestEmbed.ts';
import { buildGameEmbed } from '../render/gameEmbed.ts';
import type { Sink } from '../sinks/sink.ts';
import { computeDigest, digestFor, playerStats, type Digest, type PlayerDigest } from './digest.ts';
import { renderLeaderboard, type LeaderboardRow } from '../render/image/leaderboard.ts';
import { renderRecap, type RecapGame, type RecapHeader } from '../render/image/recap.ts';
import { renderBanPlan } from '../render/image/banplan.ts';
import { renderProfile, type ProfileData, type QueueCard } from '../render/image/profile.ts';
import { isApex } from './rank.ts';
import { discoverFivesQueue, scoutTeam } from './scout.ts';
import { saveFivesQueue } from './queues.ts';
import { renderLive, type LivePlayer } from '../render/image/live.ts';
import type { CurrentGameInfo } from '../riot/types.ts';
import { formatRank } from './rank.ts';
import { personalSpan, personalTitle, personalWindow, previousDay, previousWeek, recapTitle, recapWindow, zonedParts, type DailyWindow } from './time.ts';
import type { GameResult } from './events.ts';
import { isFivesQueue, QUEUE_TYPE_BY_ID } from '../riot/types.ts';
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

/** posts.guild_id used to dedupe the global game log channel. */
export const GAME_LOG_KEY = '#gamelog';

/** Riot accounts one Discord user can link. */
export const MAX_LINKS = 10;

/** Ranked queues the commands can be scoped to. Default everywhere: Solo/Duo. */
export const SOLO = 420;
export const FLEX = 440;
/**
 * Ranked 5s as chosen in commands and stored by /mode. Riot doesn't document the real
 * queue id; resolveQueue() swaps this for the discovered one before any lookup.
 */
export const FIVES = 5;
export const queueName = (q: number) => (q === FLEX ? 'Flex' : q === FIVES || isFivesQueue(q) ? 'Ranked 5s' : 'Solo/Duo');

/** A reply: embed plus optional PNG attachments referenced as attachment://<name>. */
export interface Reply {
  embed: Embed;
  files: { name: string; data: Buffer }[];
  /** Discord message components (raw API JSON: action rows with buttons / selects). */
  components?: object[];
}

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
    /** Region assumed for /scout when the player is unknown and none was given ("" = require it). */
    private readonly defaultRegion = '',
  ) {}

  /** Destination for the global game log (GAME_LOG_CHANNEL_ID); unset = off. */
  private gameLog: ((r: Reply) => Promise<void>) | null = null;
  setGameLog(fn: ((r: Reply) => Promise<void>) | null) {
    this.gameLog = fn;
  }

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

    // Same Riot ID stored under a PUUID from an older API key: move it over instead of duplicating.
    const stale = this.repo.findPlayerByRiotId(account.gameName ?? id.gameName, account.tagLine ?? id.tagLine);
    if (stale && stale.puuid !== account.puuid) {
      this.repo.rekeyPlayer(stale.puuid, account.puuid);
      this.repo.setKv('puuid_epoch', String(this.now()));
    }
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

  /** Add a linked account. The first one is the main; later ones are alts. */
  async linkUser(discordUserId: string, regionInput: string | undefined, riotIdInput: string): Promise<{ player: PlayerRow; entries: LeagueEntryDto[]; added: boolean; isMain: boolean }> {
    if (this.repo.linkedPlayers(discordUserId).length >= MAX_LINKS) {
      throw new UserError(`You can link up to ${MAX_LINKS} accounts. Remove one first.`);
    }
    // Region is optional for accounts the bot already knows, else the configured default.
    if (!regionInput?.trim()) {
      let known: PlayerRow | undefined;
      try {
        const id = parseRiotId(riotIdInput);
        known = this.repo.findPlayerByRiotId(id.gameName, id.tagLine);
      } catch (e) {
        throw new UserError(`${(e as Error).message} Use \`link <region> <Name#TAG>\`, e.g. \`link EUW Faker#KR1\`.`);
      }
      regionInput = known?.platform ?? this.defaultRegion;
      if (!regionInput) throw new UserError('Which region does that account play on? Add it, e.g. `EUW`.');
    }
    let res = { added: false, isMain: false };
    const r = await this.resolvePlayer(regionInput, riotIdInput, (puuid) => {
      res = this.repo.link(discordUserId, puuid);
      return res.added;
    });
    return { player: r.player, entries: r.entries, ...res };
  }

  linkedAccounts(discordUserId: string) {
    return this.repo.linkedPlayers(discordUserId);
  }

  /** Linked accounts with their best current rank, for the /link panel. */
  linkPanelData(discordUserId: string): { player: PlayerRow; isMain: boolean; rank: string | null }[] {
    const order = ['RANKED_SOLO_5x5', 'RANKED_FLEX_SR', 'RANKED_PREMADE_5x5'];
    const label: Record<string, string> = { RANKED_SOLO_5x5: 'Solo', RANKED_FLEX_SR: 'Flex', RANKED_PREMADE_5x5: '5s' };
    return this.repo.linkedPlayers(discordUserId).map((p, i) => {
      const snaps = this.repo.getSnapshots(p.puuid).filter((s) => order.includes(s.queue_type)).sort((a, b) => order.indexOf(a.queue_type) - order.indexOf(b.queue_type));
      const s = snaps[0];
      // main is listed first (or the oldest, if none is flagged)
      return { player: p, isMain: i === 0, rank: s ? `${formatRank(s)} ${label[s.queue_type]}` : null };
    });
  }

  /** One of the user's linked accounts by PUUID or Riot ID; without one, only if they have exactly one. */
  private pickLinked(discordUserId: string, account?: string): PlayerRow {
    const links = this.repo.linkedPlayers(discordUserId);
    if (!links.length) throw new UserError('You have no linked account.');
    if (!account) {
      if (links.length === 1) return links[0]!;
      throw new UserError('You have several linked accounts. Say which one, or use the buttons on `/link`.');
    }
    const a = account.trim().toLowerCase();
    const p = links.find((l) => l.puuid === account || `${l.game_name}#${l.tag_line}`.toLowerCase() === a);
    if (!p) throw new UserError(`**${account}** isn't one of your linked accounts.`);
    return p;
  }

  /** Remove a linked account. If it was the main, the oldest remaining one becomes main. */
  unlinkUser(discordUserId: string, account?: string): { player: PlayerRow; newMain: PlayerRow | null } {
    const p = this.pickLinked(discordUserId, account);
    return this.repo.unlink(discordUserId, p.puuid)!;
  }

  setMainAccount(discordUserId: string, account: string): PlayerRow {
    const p = this.pickLinked(discordUserId, account);
    this.repo.setMainLink(discordUserId, p.puuid);
    return p;
  }

  /**
   * Find an account by Riot ID. Known accounts need no region. Unknown ones are
   * resolved (region required) and from then on tracked globally like everyone else.
   */
  async lookup(riotIdInput: string, regionInput?: string): Promise<{ player: PlayerRow; isNew: boolean }> {
    let id;
    try {
      id = parseRiotId(riotIdInput);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    const platform = regionInput ? parsePlatform(regionInput) : null;
    if (regionInput && !platform) throw new UserError(`Unknown region "${regionInput}". Use one of: ${Object.values(PLATFORM_LABEL).join(', ')}`);
    const known = this.repo.findPlayerByRiotId(id.gameName, id.tagLine, platform ?? undefined);
    if (known) return { player: known, isNew: false };
    if (!platform) throw new UserError(`I don't know **${formatRiotId(id)}** yet. Add the region, e.g. \`${formatRiotId(id)} EUW\`.`);
    const r = await this.resolvePlayer(platform, riotIdInput, () => true);
    return { player: r.player, isNew: true };
  }

  /**
   * Scout a premade team for bans. The scouted player is resolved via account-v1 but NOT
   * added to tracking: they're usually an opponent, not someone to poll forever.
   */
  async banPlan(riotIdInput: string, regionInput?: string): Promise<Reply> {
    let id;
    try {
      id = parseRiotId(riotIdInput);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    const platform = regionInput ? parsePlatform(regionInput) : null;
    if (regionInput && !platform) throw new UserError(`Unknown region "${regionInput}". Use one of: ${Object.values(PLATFORM_LABEL).join(', ')}`);
    const known = this.repo.findPlayerByRiotId(id.gameName, id.tagLine, platform ?? undefined);
    const plat = platform ?? known?.platform ?? (this.defaultRegion ? parsePlatform(this.defaultRegion) : null);
    if (!plat) throw new UserError(`Add the region, e.g. \`${formatRiotId(id)} EUNE\`.`);
    // Known players are re-resolved too: cheap, and guards against PUUIDs from an older API key.
    let target: { puuid: string; name: string; tag: string; platform: Platform } | null = null;
    if (known) {
      const re = await this.tracker.rekey(known).catch(() => null);
      if (re) target = { puuid: re.puuid, name: re.game_name, tag: re.tag_line, platform: plat };
    }
    if (!target) {
      const acc = await this.riot.getAccountByRiotId(plat, id.gameName, id.tagLine);
      if (!acc) throw new UserError(`Riot ID **${formatRiotId(id)}** not found`);
      target = { puuid: acc.puuid, name: acc.gameName ?? id.gameName, tag: acc.tagLine ?? id.tagLine, platform: plat };
    }
    const report = await scoutTeam(this.repo, this.riot, target, { games: 50, log: this.log });
    if (report.sample < 3) {
      throw new UserError(`**${target.name}#${target.tag}** has only ${report.sample} Flex/Ranked 5s game${report.sample === 1 ? '' : 's'} on ${PLATFORM_LABEL[plat]}, not enough to plan bans. Wrong region?`);
    }
    const png = await renderBanPlan(report, this.assets);
    const bans = report.priorityBans.map((b) => b.championName).join(', ');
    return {
      embed: { color: 0xe74c3c, image: { url: 'attachment://scout.png' }, footer: { text: bans ? `Priority bans: ${bans}` : 'No ban suggestions' } },
      files: [{ name: 'scout.png', data: png }],
    };
  }

  private apexCache = new Map<string, { at: number; ranking: Map<string, number>; total: number }>();

  /** Position on the Master+ ladder (all apex players sorted by LP), cached 30 min per platform+queue. */
  private async apexPosition(platform: Platform, queue: string, puuid: string): Promise<{ pos: number; total: number } | null> {
    const key = `${platform}:${queue}`;
    let c = this.apexCache.get(key);
    if (!c || this.now() - c.at > 30 * 60_000) {
      const lists = await Promise.all((['challenger', 'grandmaster', 'master'] as const).map((t) => this.riot.getApexLeague(platform, t, queue).catch(() => null)));
      const all = lists.flatMap((l) => l?.entries ?? []).sort((a, b) => b.leaguePoints - a.leaguePoints);
      c = { at: this.now(), ranking: new Map(all.map((e, i) => [e.puuid, i + 1])), total: all.length };
      this.apexCache.set(key, c);
    }
    const pos = c.ranking.get(puuid);
    return pos ? { pos, total: c.total } : null;
  }

  /** Profile card: identity, Solo/Flex rank with W/L and ladder position, top mastery champions. */
  profile(player: PlayerRow): Promise<Reply> {
    return this.fresh(player, (p) => this.profileImpl(p));
  }

  private async profileImpl(player: PlayerRow): Promise<Reply> {
    const [summoner, entries, mastery] = await Promise.all([
      this.riot.getSummoner(player.platform, player.puuid).catch(() => null),
      this.riot.getLeagueEntries(player.platform, player.puuid),
      this.riot.getAllMastery(player.platform, player.puuid).catch(() => null),
    ]);
    const card = async (queueType: string, label: string): Promise<QueueCard> => {
      const e = entries.find((x) => x.queueType === queueType);
      if (!e) return { label, rank: null, wins: 0, losses: 0, ladderPos: null, hotStreak: false };
      const rank = { tier: e.tier, division: e.rank, lp: e.leaguePoints };
      let ladderPos: string | null = null;
      if (isApex(e.tier)) {
        const ap = await this.apexPosition(player.platform, queueType, player.puuid).catch(() => null);
        if (ap) ladderPos = `#${ap.pos.toLocaleString('en-US')} on ${PLATFORM_LABEL[player.platform]}`;
      }
      return { label, rank, wins: e.wins, losses: e.losses, ladderPos, hotStreak: e.hotStreak };
    };
    const queues = await Promise.all([card('RANKED_SOLO_5x5', 'Solo/Duo'), card('RANKED_FLEX_SR', 'Flex'), card('RANKED_PREMADE_5x5', 'Ranked 5s')]);
    const recent = this.repo.lpHistory(player.puuid, SOLO, 10).map((r) => !!r.win);
    const latest = this.repo.latestDoneMatches(player.puuid, 1)[0];
    const version = (latest && this.repo.getCachedMatch(latest.match_id)?.info.gameVersion) || '99.99';
    const data: ProfileData = {
      name: player.game_name, tag: player.tag_line, region: PLATFORM_LABEL[player.platform],
      level: summoner?.summonerLevel ?? null, iconId: summoner?.profileIconId ?? null,
      queues,
      champs: [...(mastery ?? [])].sort((a, b) => b.championPoints - a.championPoints).slice(0, 5)
        .map((m) => ({ championId: m.championId, points: m.championPoints, level: m.championLevel })),
      masteryScore: mastery ? mastery.reduce((n, m) => n + m.championLevel, 0) : null,
      championsPlayed: mastery ? mastery.filter((m) => m.championPoints > 0).length : null,
      recent, version,
    };
    const png = await renderProfile(data, this.assets);
    return {
      embed: { color: queues.some((q) => q.rank) ? 0x5865f2 : 0x4f545c, image: { url: 'attachment://profile.png' } },
      files: [{ name: 'profile.png', data: png }],
    };
  }

  /** Queue for a command: explicit argument, else the caller's /mode preference, else Solo/Duo. */
  queueFor(discordUserId: string, explicit?: number): number {
    return explicit ?? this.repo.getDefaultQueue(discordUserId) ?? SOLO;
  }
  setDefaultQueue(discordUserId: string, queueId: number) {
    if (queueId !== SOLO && queueId !== FLEX && queueId !== FIVES) throw new UserError('Mode must be `solo`, `flex` or `5s`.');
    this.repo.setDefaultQueue(discordUserId, queueId);
  }

  /**
   * Turn the Ranked 5s pseudo id into the real queue id: the stored one, else discovered
   * from `player`'s match history. Stays FIVES (matches nothing) if 5s was never seen.
   */
  async resolveQueue(queueId: number, player?: PlayerRow): Promise<number> {
    if (queueId !== FIVES) return queueId;
    const known = Object.entries(QUEUE_TYPE_BY_ID).find(([id]) => isFivesQueue(Number(id)));
    if (known) return Number(known[0]);
    if (!player) return FIVES;
    return (await discoverFivesQueue(this.repo, this.riot, player.platform, player.puuid).catch(() => null)) ?? FIVES;
  }

  /** The account a command should act on: the given Discord user's link (or the caller's). */
  linkedOrThrow(discordUserId: string, isSelf: boolean, style = '/'): PlayerRow {
    const p = this.repo.linkedPlayer(discordUserId);
    if (!p) throw new UserError(isSelf ? `You have no linked account. Use \`${style}link\` first.` : 'That user has no linked account.');
    return p;
  }

  /** All accounts linked to a Discord user (main first). */
  linkedAllOrThrow(discordUserId: string, isSelf: boolean, style = '/'): PlayerRow[] {
    const ps = this.repo.linkedPlayers(discordUserId);
    if (!ps.length) throw new UserError(isSelf ? `You have no linked account. Use \`${style}link\` first.` : 'That user has no linked account.');
    return ps;
  }

  /** Run fn; if Riot can't decrypt the stored PUUID (API key changed), re-resolve the player and retry once. */
  private async fresh<T>(player: PlayerRow, fn: (p: PlayerRow) => Promise<T>): Promise<T> {
    try {
      return await fn(player);
    } catch (e) {
      if (!isStalePuuidError(e)) throw e;
      const re = await this.tracker.rekey(player);
      if (!re) throw new UserError(`Couldn't refresh **${player.game_name}#${player.tag_line}** after an API key change (renamed?). Look them up again with their current Riot ID.`);
      return fn(re);
    }
  }

  /**
   * Most recent ranked game, with LP if the tracker resolved it. Without a queue it's the
   * newest game across Solo/Duo, Flex and Ranked 5s (the /mode default doesn't apply here).
   */
  recent(player: PlayerRow, queueId?: number): Promise<Reply> {
    return this.fresh(player, async (p) => this.recentImpl(p, queueId === undefined ? undefined : await this.resolveQueue(queueId, p)));
  }

  /**
   * /recent for a Discord user with several linked accounts: the newest game across all
   * of them (by game end time), not just the main.
   */
  async recentAcross(players: PlayerRow[], queueId?: number): Promise<Reply> {
    if (players.length === 1) return this.recent(players[0]!, queueId);
    const latest = await Promise.all(players.map((pl) =>
      this.fresh(pl, async (p) => {
        const q = queueId === undefined ? undefined : await this.resolveQueue(queueId, p);
        const [id] = await this.riot.getMatchIds(p.platform, p.puuid, q === undefined ? { count: 1, type: 'ranked' } : { count: 1, queue: q });
        if (!id) return null;
        const m = this.repo.getCachedMatch(id) ?? (await this.riot.getMatch(p.platform, id));
        if (!m) return null;
        this.repo.cacheMatch(m);
        return { player: p, q, id, end: m.info.gameEndTimestamp ?? m.info.gameStartTimestamp + m.info.gameDuration * 1000 };
      }).catch((e) => {
        if (!(e instanceof UserError)) this.log(`recent: ${pl.game_name}#${pl.tag_line} failed: ${(e as Error).message}`);
        return null;
      })));
    const best = latest.filter((x) => x !== null).sort((a, b) => b.end - a.end)[0];
    if (!best) throw new UserError(`No ${queueId === undefined ? 'ranked' : queueName(queueId)} games found on any linked account.`);
    return this.recentImpl(best.player, best.q, best.id);
  }

  private async recentImpl(player: PlayerRow, queueId: number | undefined, knownId?: string): Promise<Reply> {
    const [id] = knownId ? [knownId] : await this.riot.getMatchIds(player.platform, player.puuid, queueId === undefined ? { count: 1, type: 'ranked' } : { count: 1, queue: queueId });
    if (!id) throw new UserError(`No ${queueId === undefined ? 'ranked' : queueName(queueId)} games found for **${player.game_name}#${player.tag_line}**.`);
    const match = this.repo.getCachedMatch(id) ?? (await this.riot.getMatch(player.platform, id));
    if (!match) throw new UserError('Could not load that match from Riot, try again in a bit.');
    this.repo.cacheMatch(match);
    // A ranked game outside Solo/Flex is Ranked 5s: remember its queue id.
    const q = match.info.queueId;
    if (queueId === undefined && !(q in QUEUE_TYPE_BY_ID) && match.info.participants.length === 10) saveFivesQueue(this.repo, q);

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

  /**
   * /live for a Discord user: the first of their linked accounts that's in a game
   * (main first), else "not in game".
   */
  async liveAcross(players: PlayerRow[]): Promise<Reply> {
    for (const pl of players) {
      const r = await this.fresh(pl, (p) => this.liveGame(p)).catch((e) => {
        if (!(e instanceof UserError)) this.log(`live: ${pl.game_name}#${pl.tag_line} failed: ${(e as Error).message}`);
        return null;
      });
      if (r) return this.renderLiveReply(r.player, r.game);
    }
    throw new UserError(players.length > 1
      ? "None of your linked accounts is in a game right now. Try again once you're on the loading screen."
      : `**${players[0]!.game_name}#${players[0]!.tag_line}** isn't in a game right now. Try again once they're on the loading screen.`);
  }

  /** /live for one account. */
  async live(player: PlayerRow): Promise<Reply> {
    const r = await this.fresh(player, (p) => this.liveGame(p));
    if (!r) throw new UserError(`**${player.game_name}#${player.tag_line}** isn't in a game right now. Try again once they're on the loading screen.`);
    return this.renderLiveReply(r.player, r.game);
  }

  private async liveGame(player: PlayerRow): Promise<{ player: PlayerRow; game: CurrentGameInfo } | null> {
    const game = await this.riot.getActiveGame(player.platform, player.puuid);
    return game ? { player, game } : null;
  }

  private async renderLiveReply(player: PlayerRow, g: CurrentGameInfo): Promise<Reply> {
    // Ranks for everyone (hidden players and bots have no PUUID to look up).
    const entries = await Promise.all(g.participants.map((p) =>
      p.puuid && !p.bot ? this.riot.getLeagueEntries(player.platform, p.puuid).catch(() => [] as LeagueEntryDto[]) : Promise.resolve([] as LeagueEntryDto[])));
    const rank = (es: LeagueEntryDto[], q: string) => {
      const e = es.find((x) => x.queueType === q);
      return e ? { tier: e.tier, division: e.rank, lp: e.leaguePoints, wins: e.wins, losses: e.losses } : null;
    };
    const players: LivePlayer[] = g.participants.map((p, i) => {
      const [gameName, tagLine] = p.riotId?.includes('#') ? [p.riotId.slice(0, p.riotId.lastIndexOf('#')), p.riotId.slice(p.riotId.lastIndexOf('#') + 1)] : [p.riotId || null, null];
      const known = p.puuid ? this.repo.getPlayer(p.puuid) : undefined;
      return {
        puuid: p.puuid || null,
        gameName: gameName ?? known?.game_name ?? null,
        tagLine: tagLine ?? known?.tag_line ?? null,
        bot: !!p.bot,
        championId: p.championId,
        teamId: p.teamId,
        spells: [p.spell1Id, p.spell2Id],
        perkIds: p.perks?.perkIds ?? [],
        perkSubStyle: p.perks?.perkSubStyle ?? 0,
        solo: rank(entries[i]!, 'RANKED_SOLO_5x5'),
        flex: rank(entries[i]!, 'RANKED_FLEX_SR'),
        focus: p.puuid === player.puuid,
        known: !!known && p.puuid !== player.puuid,
      };
    });
    const q = g.gameQueueConfigId;
    const queueLabel = (q && QUEUE_LABEL[q]) || (g.gameMode === 'CLASSIC' ? 'Summoner\'s Rift' : g.gameMode.charAt(0) + g.gameMode.slice(1).toLowerCase());
    // gameLength is only refreshed now and then; time since gameStartTime is more current.
    const seconds = g.gameStartTime > 0 ? Math.max(0, Math.round((this.now() - g.gameStartTime) / 1000)) : null;
    if (!this.assets) throw new UserError('Live games need images, which are turned off on this bot.');
    const png = await renderLive({ queueLabel, seconds, bans: g.bannedChampions, players }, this.assets);
    return {
      embed: {
        color: 0xf85149,
        image: { url: 'attachment://live.png' },
        footer: { text: `${player.game_name}#${player.tag_line} · ${PLATFORM_LABEL[player.platform]}` },
      },
      files: [{ name: 'live.png', data: png }],
    };
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

  /** Data behind the personal recap image (exposed for tests). Null when there are no games. */
  recapData(player: PlayerRow, kind: 'daily' | 'weekly', queueId = SOLO, window: DailyWindow = 'today', tz = this.defaultTz): { header: RecapHeader; games: RecapGame[] } | null {
    const period = personalWindow(kind, window, this.now(), tz);
    const stats = playerStats(this.repo, player, period, queueId);
    const rows = this.repo.doneMatchesBetween(player.puuid, period.from, period.to).filter((m) => m.queue_id === queueId).reverse(); // newest first
    if (!rows.length) return null;
    const MAX_ROWS = 20;
    const games: RecapGame[] = rows.slice(0, MAX_ROWS).map((row) => {
      const m = this.repo.getCachedMatch(row.match_id);
      const me = m?.info.participants.find((p) => p.puuid === player.puuid);
      return {
        championId: me?.championId ?? 0,
        championName: me?.championName ?? '?',
        gameVersion: m?.info.gameVersion ?? '0.0',
        kills: me?.kills ?? 0, deaths: me?.deaths ?? 0, assists: me?.assists ?? 0,
        result: row.remake ? 'remake' : row.win ? 'win' : 'loss',
        lpDelta: row.lp_delta,
        lpNote: row.note === 'batched' ? 'batched' : row.note === 'placement' ? 'placement' : undefined,
      };
    });
    const snap = stats.ranks.find((r) => r.queue_type === QUEUE_TYPE_BY_ID[queueId]);
    return {
      header: {
        name: player.game_name, tag: player.tag_line, title: `${personalTitle(kind, window)} · ${queueName(queueId)}`,
        subtitle: period.label,
        games: stats.games, wins: stats.wins, losses: stats.losses, lpNet: stats.lpNet,
        rank: snap ? { tier: snap.tier, division: snap.division, lp: snap.lp, queue: queueName(queueId) } : null,
        hiddenCount: Math.max(0, rows.length - MAX_ROWS),
        pending: this.repo.pendingMatches(player.puuid).filter((m) => m.queue_id === queueId).length,
      },
      games,
    };
  }

  /** Personal daily/weekly recap: rendered list of games (champ, KDA, W/L, LP). */
  async personalRecap(player: PlayerRow, kind: 'daily' | 'weekly', queueId = SOLO, window: DailyWindow = 'today', tz = this.defaultTz): Promise<Reply> {
    const data = this.recapData(player, kind, queueId, window, tz);
    const title = `${personalTitle(kind, window)} · ${queueName(queueId)}`;
    if (!data) {
      const pending = this.repo.pendingMatches(player.puuid).filter((m) => m.queue_id === queueId).length;
      const desc = `No ${queueName(queueId)} games ${personalSpan(kind, window)}. 💤` + (pending ? `\n_${pending} game${pending === 1 ? '' : 's'} waiting for LP to update_` : '');
      return { embed: { author: { name: `${player.game_name}#${player.tag_line} · ${PLATFORM_LABEL[player.platform]}` }, title, description: desc, color: 0x5865f2 }, files: [] };
    }
    const lpNet = data.header.lpNet;
    try {
      const png = await renderRecap(data.header, data.games, this.assets);
      const name = `${kind}.png`;
      return { embed: { color: lpNet > 0 ? 0x2ecc71 : lpNet < 0 ? 0xe74c3c : 0x5865f2, image: { url: `attachment://${name}` } }, files: [{ name, data: png }] };
    } catch (e) {
      this.log(`recap render failed, using text: ${(e as Error).message}`);
      const period = personalWindow(kind, window, this.now(), tz);
      const rows = this.repo.doneMatchesBetween(player.puuid, period.from, period.to).filter((m) => m.queue_id === queueId).reverse();
      return {
        embed: buildPersonalRecapEmbed({ player, periodLabel: title, stats: playerStats(this.repo, player, period, queueId), games: rows.map((row) => ({ row, match: this.repo.getCachedMatch(row.match_id) })), pending: data.header.pending }),
        files: [],
      };
    }
  }


  /** Server leaderboard image: only accounts that played in the period, sorted by LP gained. */
  async leaderboard(guildId: string, kind: 'daily' | 'weekly', queueId = SOLO): Promise<Reply> {
    const g = this.guild(guildId);
    return this.leaderboardFor(this.repo.trackedInGuild(guildId), g.timezone, kind, queueId, {
      title: `Leaderboard · ${recapTitle(kind)} · ${queueName(queueId)}`,
      none: 'No accounts tracked in this server yet. Use `/track add` or `$track add`.',
      who: 'tracked account',
    });
  }

  /** Admin: leaderboard across every account the bot knows (all servers, links and lookups). */
  async globalLeaderboard(kind: 'daily' | 'weekly', queueId = SOLO): Promise<Reply> {
    return this.leaderboardFor(this.repo.activePlayers(), this.defaultTz, kind, queueId, {
      title: `Global leaderboard · ${recapTitle(kind)} · ${queueName(queueId)}`,
      none: 'No accounts known yet.',
      who: 'known account',
    });
  }

  private async leaderboardFor(list: PlayerRow[], tz: string, kind: 'daily' | 'weekly', queueId: number, text: { title: string; none: string; who: string }): Promise<Reply> {
    const period = recapWindow(kind, this.now(), tz);
    const d = digestFor(this.repo, list, 'adhoc', period, queueId);
    const { title } = text;
    const played = d.players.filter((p) => p.games > 0);

    if (!played.length) {
      const msg = d.players.length
        ? `No ${queueName(queueId)} games in the ${kind === 'daily' ? 'past 24 hours' : 'past 7 days'} by the ${d.players.length} ${text.who}${d.players.length === 1 ? '' : 's'}. 💤`
        : text.none;
      return { embed: { title, description: msg, color: 0x5865f2 }, files: [] };
    }

    const rows = this.leaderboardRows(played, period, queueId).slice(0, 20);
    const sd = this.assets ? await this.assets.staticData(rows.find((r) => r.champ)?.champ?.version ?? '99.99').catch(() => null) : null;
    const t = d.totals;
    const subtitle = period.label;
    try {
      const png = await renderLeaderboard(rows, {
        title,
        subtitle: played.length > 20 ? `${subtitle} · top 20 of ${played.length}` : subtitle,
        totals: { games: t.games, wins: t.wins, losses: t.losses, lpNet: played.reduce((n, p) => n + p.lpNet, 0), players: played.length, tracked: d.players.length },
        hiddenCount: d.players.length - played.length,
      }, this.assets, sd);
      return { embed: { color: 0x5865f2, image: { url: 'attachment://leaderboard.png' } }, files: [{ name: 'leaderboard.png', data: png }] };
    } catch (e) {
      this.log(`leaderboard render failed, using text: ${(e as Error).message}`);
      return { embed: buildLeaderboardEmbed({ ...d, players: played }, title), files: [] };
    }
  }

  // ---- admin ----

  /** Every known account with link/server/game counts, paged. */
  adminPlayers(page: number, perPage = 15) {
    const all = this.repo.playerOverview();
    const pages = Math.max(1, Math.ceil(all.length / perPage));
    const p = Math.min(Math.max(1, page), pages);
    return { rows: all.slice((p - 1) * perPage, p * perPage), page: p, pages, total: all.length };
  }

  /** Discord user -> Riot account links, paged (10 per page). */
  adminLinks(page: number, perPage = 10) {
    const all = this.repo.allLinks();
    const pages = Math.max(1, Math.ceil(all.length / perPage));
    const p = Math.min(Math.max(1, page), pages);
    return { rows: all.slice((p - 1) * perPage, p * perPage), page: p, pages, total: all.length };
  }

  /** What `admin remove` would delete (dry run) or deletes (confirm). */
  adminRemove(riotIdInput: string, confirm: boolean) {
    let id;
    try {
      id = parseRiotId(riotIdInput);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    const p = this.repo.findPlayerByRiotId(id.gameName, id.tagLine);
    if (!p) throw new UserError(`No known account **${formatRiotId(id)}**.`);
    const counts = this.repo.playerFootprint(p.puuid);
    if (confirm) this.repo.purgePlayer(p.puuid);
    return { player: p, counts, done: confirm };
  }

  /** Sorted leaderboard rows (LP gained, then wins, then games). Exposed for tests. */
  leaderboardRows(played: PlayerDigest[], period: { from: number; to: number }, queueId = SOLO): LeaderboardRow[] {
    return [...played]
      .sort((a, b) => b.lpNet - a.lpNet || b.wins - a.wins || b.games - a.games)
      .map((p) => this.leaderboardRow(p, period, queueId));
  }

  private leaderboardRow(p: PlayerDigest, period: { from: number; to: number }, queueId: number): LeaderboardRow {
    const ms = this.repo.doneMatchesBetween(p.player.puuid, period.from, period.to).filter((m) => !m.remake && m.queue_id === queueId);
    const rank = p.ranks.find((r) => r.queue_type === QUEUE_TYPE_BY_ID[queueId]) ?? null;
    const spark = pointsFromHistory(ms).map((x) => x.abs);

    // most played champion
    const champCount = new Map<string, { id: number; name: string; version: string; n: number }>();
    for (const m of ms) {
      const match = this.repo.getCachedMatch(m.match_id);
      const me = match?.info.participants.find((x) => x.puuid === p.player.puuid);
      if (!me || !match) continue;
      const c = champCount.get(me.championName) ?? { id: me.championId, name: me.championName, version: match.info.gameVersion, n: 0 };
      c.n++;
      champCount.set(me.championName, c);
    }
    const top = [...champCount.values()].sort((a, b) => b.n - a.n)[0];
    return {
      name: p.player.game_name,
      tag: p.player.tag_line,
      region: p.player.platform,
      games: p.games,
      wins: p.wins,
      losses: p.losses,
      lpNet: p.lpNet,
      rank: rank ? { tier: rank.tier, division: rank.division, lp: rank.lp } : null,
      queueLabel: queueName(queueId),
      spark,
      results: ms.map((m) => !!m.win),
      champ: top ? { id: top.id, name: top.name, version: top.version } : null,
    };
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
    await this.postGameLog(games);
    for (const a of adjustments) {
      for (const guild of this.repo.guildsTracking(a.player.puuid)) {
        await this.sink.send(guild, 'notice', [buildAdjustmentEmbed(a.player.game_name, a.queueType, a.delta, formatRank(a.rankBefore), formatRank(a.rankAfter))], { label: `adj-${a.player.game_name}` });
      }
    }
    return { games: games.length, requests };
  }

  /**
   * Global game log: one post per match, however many known accounts played in it.
   * Deduped in the posts table (pseudo-guild GAME_LOG_KEY), so restarts and accounts whose
   * LP resolves in a later tick never post the same match twice.
   */
  async postGameLog(games: GameResult[]): Promise<void> {
    if (!this.gameLog) return;
    const byMatch = new Map<string, GameResult[]>();
    for (const g of games) {
      const id = g.match.metadata.matchId;
      byMatch.set(id, [...(byMatch.get(id) ?? []), g]);
    }
    const ordered = [...byMatch.entries()].sort((a, b) => (a[1][0]!.match.info.gameEndTimestamp ?? 0) - (b[1][0]!.match.info.gameEndTimestamp ?? 0));
    for (const [matchId, group] of ordered) {
      if (this.repo.isPosted(GAME_LOG_KEY, matchId, '')) continue;
      try {
        const [first, ...rest] = group;
        const reply = await this.gameReply(first!, new Set(rest.map((g) => g.player.puuid)));
        if (rest.length) {
          const lines = rest.map((g) => `**${g.player.game_name}#${g.player.tag_line}** · ${g.remake ? 'Remake' : g.win ? 'Victory' : 'Defeat'}${g.lpDelta !== null ? ` · ${signed(g.lpDelta)} LP` : ''}`);
          reply.embed.description = `${reply.embed.description ?? ''}\nAlso in this game: ${lines.join(' · ')}`.trim();
        }
        await this.gameLog(reply);
        this.repo.markPosted(GAME_LOG_KEY, matchId, '');
      } catch (e) {
        // Mark anyway so a broken channel/permission doesn't retry forever; the game is still recorded.
        this.repo.markPosted(GAME_LOG_KEY, matchId, '');
        this.log(`game log: could not post ${matchId}: ${(e as Error).message}`);
      }
    }
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
