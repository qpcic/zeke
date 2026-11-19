import { signed } from '../render/format.ts';
import type { GuildRow, PlayerMatchRow, PlayerRow, Repo } from '../db/repo.ts';
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
import { compareDivision, formatTierDiv, isApex, winsToNext, type Rank } from './rank.ts';
import { discoverFivesQueue, scoutPlayers, scoutTeam } from './scout.ts';
import { saveFivesQueue } from './queues.ts';
import { renderLive, type LivePlayer } from '../render/image/live.ts';
import { renderGamesBoard, type GamesRow } from '../render/image/gamesBoard.ts';
import { renderLadder, type LadderRow } from '../render/image/ladder.ts';
import { renderChamp, type ChampCard, type ChampGame } from '../render/image/champ.ts';
import { linkButtonRow, liveGameLinks, matchLinks, profileLinks } from '../render/statsLinks.ts';
import type { CurrentGameInfo, MatchDto, ParticipantDto } from '../riot/types.ts';
import { formatRank } from './rank.ts';
import { personalSpan, personalTitle, personalWindow, previousDay, previousWeek, recapTitle, recapWindow, zonedParts, type DailyWindow, type Period } from './time.ts';
import type { GameResult, LpAdjustment } from './events.ts';
import { isFivesQueue, QUEUE_TYPE_BY_ID } from '../riot/types.ts';
import { buildLeaderboardEmbed, buildPersonalRecapEmbed } from '../render/statsEmbeds.ts';
import type { Embed } from '../render/embed.ts';
import type { AssetSource, StaticData } from '../assets/ddragon.ts';
import { championName } from '../assets/ddragon.ts';
import { performances } from './performance.ts';
import { renderScoreboard } from '../render/image/scoreboard.ts';
import { pointsFromHistory, renderLpGraph } from '../render/image/lpGraph.ts';
import { QUEUE_LABEL } from '../riot/types.ts';
import type { Tracker } from './tracker.ts';

export class UserError extends Error {}

/** posts.guild_id used to dedupe the global game log channel. */
export const GAME_LOG_KEY = '#gamelog';

/** Sends and edits game-log messages; send returns the new message's id. */
export interface LogPoster {
  send(channelId: string, r: Reply): Promise<string>;
  edit(channelId: string, messageId: string, r: Reply): Promise<void>;
}

export interface RankChange { player: PlayerRow; queueType: string; from: Rank; to: Rank; up: boolean }

const QUEUE_TYPE_LABEL: Record<string, string> = { RANKED_SOLO_5x5: 'Solo/Duo', RANKED_FLEX_SR: 'Flex', RANKED_PREMADE_5x5: 'Ranked 5s' };

/** Riot accounts one Discord user can link. */
export const MAX_LINKS = 10;

/** /champ looks at this many recent ranked games. */
export const CHAMP_SAMPLE = 50;

const normChamp = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** Champion id from user text: exact name/id, then prefix ("mf" style aliases too), then games seen. */
export function findChampion(input: string, sd: StaticData | null, seen: { id: number; name: string }[]): number | null {
  const q = normChamp(input);
  if (!q) return null;
  const alias: Record<string, string> = { mf: 'missfortune', tf: 'twistedfate', ww: 'warwick', j4: 'jarvaniv', asol: 'aurelionsol', mundo: 'drmundo', nunu: 'nunuwillump', kass: 'kassadin', yi: 'masteryi', lee: 'leesin', cass: 'cassiopeia', heim: 'heimerdinger', kog: 'kogmaw', voli: 'volibear', blitz: 'blitzcrank', naut: 'nautilus' };
  const want = alias[q] ?? q;
  const all = [
    ...(sd ? [...sd.champions.values()].map((c) => ({ id: c.key, names: [normChamp(c.name), normChamp(c.id)] })) : []),
    ...seen.map((s) => ({ id: s.id, names: [normChamp(s.name)] })),
  ];
  return all.find((c) => c.names.includes(want))?.id
    ?? all.filter((c) => c.names.some((n) => n.startsWith(want))).sort((a, b) => a.names[0]!.length - b.names[0]!.length)[0]?.id
    ?? null;
}

/** Daily recap goes out this long after local midnight (late games' LP settles first). */
export const RECAP_DELAY_MS = 10 * 60_000;

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
  /** Set when LP isn't in yet: the Discord layer can register the message for an update. */
  watch?: { matchId: string; puuid: string };
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

  /**
   * Where game logs go: the global GAME_LOG_CHANNEL_ID (if set) and every /log channel.
   * send returns the message id, so a post can be edited once LP is in. Unset = off.
   */
  private logPoster: LogPoster | null = null;
  private gameLogChannel: string | null = null;
  setLogPoster(poster: LogPoster | null, gameLogChannelId?: string) {
    this.logPoster = poster;
    this.gameLogChannel = gameLogChannelId || null;
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

  /** For `$admin health`: Riot API metrics and rate-limit use. */
  riotHealth(windowMs = 3_600_000) {
    return { api: this.riot.metrics.summary(windowMs), limits: this.riot.limiterUsage() };
  }

  /** For `$admin health`: table sizes and the poll queue. */
  dbHealth() {
    return { counts: this.repo.tableCounts(), backlog: this.repo.pollBacklog(this.now()) };
  }

  /** For `$admin stats`. */
  usage(since: number) {
    return this.repo.usageSince(since);
  }

  /** Discord users with a linked account (for /ladder's member lookup). */
  linkedUserIds(): string[] {
    return this.repo.linkedUserIds();
  }

  /**
   * /ladder: the server's tracked accounts plus every linked account (alts too) of the
   * given server members, sorted by current rank in one queue.
   */
  async ladder(guildId: string, members: { id: string; name: string }[], queueId: number): Promise<Reply> {
    const q = await this.resolveQueue(queueId);
    const queueType = QUEUE_TYPE_BY_ID[q] ?? (queueId === FIVES ? 'RANKED_PREMADE_5x5' : 'RANKED_SOLO_5x5');
    const entries = new Map<string, { player: PlayerRow; owners: string[] }>();
    const add = (p: PlayerRow, owner?: string) => {
      const e = entries.get(p.puuid) ?? { player: p, owners: [] };
      if (owner) e.owners.push(owner);
      entries.set(p.puuid, e);
    };
    for (const p of this.repo.trackedInGuild(guildId)) add(p);
    for (const m of members) {
      for (const p of this.repo.linkedPlayers(m.id)) add(p, `@${m.name}${p.is_main ? '' : ' · alt'}`);
    }
    return this.ladderReply([...entries.values()].map((e) => ({ player: e.player, owner: e.owners.join(', ') || 'tracked' })), queueType, {
      title: `Server ladder · ${queueName(queueId)}`,
      note: 'Tracked accounts + linked accounts of server members',
    });
  }

  /**
   * `$admin globalladder`: every account the bot knows, by current rank, 25 per page.
   * Second line shows region and whether it's linked / tracked in servers.
   */
  async globalLadder(queueId: number, page = 1): Promise<Reply> {
    const q = await this.resolveQueue(queueId);
    const queueType = QUEUE_TYPE_BY_ID[q] ?? (queueId === FIVES ? 'RANKED_PREMADE_5x5' : 'RANKED_SOLO_5x5');
    const linked = this.repo.linkedPuuids();
    const entries = this.repo.activePlayers().map((p) => {
      const servers = this.repo.guildsTracking(p.puuid).length;
      const isLinked = linked.has(p.puuid);
      const how = [isLinked ? 'linked' : '', servers ? `${servers} server${servers === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') || 'looked up';
      return { player: p, owner: `${PLATFORM_LABEL[p.platform]} · ${how}` };
    });
    return this.ladderReply(entries, queueType, { title: `Global ladder · ${queueName(queueId)}`, note: 'Every account Zeke knows', page });
  }

  private async ladderReply(entries: { player: PlayerRow; owner: string }[], queueType: string, o: { title: string; note: string; page?: number }): Promise<Reply> {
    const rows: LadderRow[] = [];
    let unranked = 0;
    for (const { player, owner } of entries) {
      const s = this.repo.getSnapshot(player.puuid, queueType);
      if (!s || !s.tier || s.tier === 'UNRANKED') {
        unranked++;
        continue;
      }
      rows.push({ name: player.game_name, tag: player.tag_line, owner, tier: s.tier, division: s.division, lp: s.lp, wins: s.wins, losses: s.losses });
    }
    rows.sort((a, b) => compareDivision(b, a) || b.lp - a.lp);
    const per = 25;
    const pages = Math.max(1, Math.ceil(rows.length / per));
    const page = Math.min(Math.max(1, o.page ?? 1), pages);
    const shown = rows.slice((page - 1) * per, page * per);
    const png = await renderLadder(shown, {
      title: o.title,
      subtitle: `${rows.length} ranked account${rows.length === 1 ? '' : 's'}${pages > 1 ? ` · page ${page}/${pages}` : ''}`,
      footer: [unranked ? `${unranked} unranked hidden` : '', `${o.note} · ranks as of their last check`].filter(Boolean).join('  ·  '),
      startRank: (page - 1) * per,
    }, this.assets);
    return { embed: { color: 0x5865f2, image: { url: 'attachment://ladder.png' } }, files: [{ name: 'ladder.png', data: png }] };
  }

  /**
   * /duo and /rivals: every cached game where one of `mine` and one of `theirs` played,
   * split into same team (duo) and opposite teams (rivals). Uses every linked account.
   */
  private sharedGames(mine: PlayerRow[], theirs: PlayerRow[]) {
    const mySet = new Set(mine.map((p) => p.puuid));
    const theirSet = new Set(theirs.map((p) => p.puuid));
    const seen = new Set<string>();
    const out: { m: MatchDto; me: ParticipantDto; them: ParticipantDto; together: boolean }[] = [];
    for (const p of mine) {
      for (const m of this.repo.cachedMatchesWith(p.puuid)) {
        if (seen.has(m.metadata.matchId)) continue;
        seen.add(m.metadata.matchId);
        const me = m.info.participants.find((x) => mySet.has(x.puuid));
        const them = m.info.participants.find((x) => theirSet.has(x.puuid));
        if (!me || !them || me.puuid === them.puuid || me.gameEndedInEarlySurrender) continue;
        out.push({ m, me, them, together: me.teamId === them.teamId });
      }
    }
    return out.sort((a, b) => (b.m.info.gameEndTimestamp ?? 0) - (a.m.info.gameEndTimestamp ?? 0));
  }

  async duo(mine: PlayerRow[], theirs: PlayerRow[], myName: string, theirName: string): Promise<Reply> {
    const games = this.sharedGames(mine, theirs).filter((g) => g.together);
    if (!games.length) throw new UserError(`No games of **${myName}** and **${theirName}** on the same team found yet.`);
    const wins = games.filter((g) => g.me.win).length;
    const byQueue = new Map<string, number>();
    for (const g of games) byQueue.set(queueName(g.m.info.queueId), (byQueue.get(queueName(g.m.info.queueId)) ?? 0) + 1);
    const pairs = new Map<string, { w: number; l: number }>();
    for (const g of games) {
      const k = `${g.me.championName} + ${g.them.championName}`;
      const s = pairs.get(k) ?? { w: 0, l: 0 };
      g.me.win ? s.w++ : s.l++;
      pairs.set(k, s);
    }
    const best = [...pairs].filter(([, s]) => s.w + s.l >= 2)
      .sort((a, b) => b[1].w / (b[1].w + b[1].l) - a[1].w / (a[1].w + a[1].l) || b[1].w + b[1].l - (a[1].w + a[1].l)).slice(0, 5);
    const recent = games.slice(0, 10).reverse().map((g) => (g.me.win ? '🟩' : '🟥')).join('');
    const last = games[0]!.m.info.gameEndTimestamp ?? games[0]!.m.info.gameStartTimestamp;
    return {
      embed: {
        title: `🤝 ${myName} & ${theirName}`,
        color: wins / games.length >= 0.5 ? 0x3fb950 : 0xf85149,
        description: `**${wins}W ${games.length - wins}L** together · ${Math.round((wins / games.length) * 100)}% in ${games.length} game${games.length === 1 ? '' : 's'}\n` +
          `${[...byQueue].map(([q, n]) => `${q} ${n}`).join(' · ')} · last <t:${Math.floor(last / 1000)}:R>`,
        fields: [
          { name: 'Recent', value: recent, inline: false },
          ...(best.length ? [{ name: 'Best champion pairs', value: best.map(([k, s]) => `**${k}** · ${s.w}W ${s.l}L`).join('\n'), inline: false }] : []),
        ],
        footer: { text: 'From games Zeke has seen (tracked accounts, /recent, /scout …) · all linked accounts count' },
      },
      files: [],
    };
  }

  async rivals(mine: PlayerRow[], theirs: PlayerRow[], myName: string, theirName: string): Promise<Reply> {
    const games = this.sharedGames(mine, theirs).filter((g) => !g.together);
    if (!games.length) throw new UserError(`No games of **${myName}** against **${theirName}** found yet.`);
    const wins = games.filter((g) => g.me.win).length;
    const lane = games.filter((g) => g.me.teamPosition && g.me.teamPosition === g.them.teamPosition);
    const laneW = lane.filter((g) => g.me.win).length;
    const avg = (f: (g: (typeof games)[number]) => number) => games.reduce((s, g) => s + f(g), 0) / games.length;
    const kda = (k: number, d: number, a: number) => `${k.toFixed(1)} / ${d.toFixed(1)} / ${a.toFixed(1)}`;
    const recent = games.slice(0, 10).reverse().map((g) => (g.me.win ? '🟩' : '🟥')).join('');
    const top = (pick: (g: (typeof games)[number]) => string) => {
      const c = new Map<string, number>();
      for (const g of games) c.set(pick(g), (c.get(pick(g)) ?? 0) + 1);
      return [...c].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, k]) => `${n} ${k}×`).join(', ');
    };
    const lead = wins > games.length - wins ? myName : wins < games.length - wins ? theirName : null;
    return {
      embed: {
        title: `⚔️ ${myName} vs ${theirName}`,
        color: wins * 2 >= games.length ? 0x3fb950 : 0xf85149,
        description: `**${myName} ${wins} – ${games.length - wins} ${theirName}** in ${games.length} game${games.length === 1 ? '' : 's'} against each other` +
          (lead ? ` · ${lead} leads` : ' · dead even') +
          (lane.length ? `\nSame lane ${lane.length}× · ${laneW}–${lane.length - laneW}` : ''),
        fields: [
          { name: `${myName} KDA`, value: kda(avg((g) => g.me.kills), avg((g) => g.me.deaths), avg((g) => g.me.assists)), inline: true },
          { name: `${theirName} KDA`, value: kda(avg((g) => g.them.kills), avg((g) => g.them.deaths), avg((g) => g.them.assists)), inline: true },
          { name: 'Recent (your side)', value: recent, inline: false },
          { name: 'Most played against each other', value: `${myName}: ${top((g) => g.me.championName)}\n${theirName}: ${top((g) => g.them.championName)}`, inline: false },
        ],
        footer: { text: 'From games Zeke has seen (tracked accounts, /recent, /scout …) · all linked accounts count' },
      },
      files: [],
    };
  }

  /** Champion names for /champ autocomplete. */
  async championNames(): Promise<string[]> {
    const sd = this.assets ? await this.assets.staticData('').catch(() => null) : null;
    return sd ? [...sd.champions.values()].map((c) => c.name).sort() : [];
  }

  /**
   * /champ: one player's games on a champion within their last 50 ranked games. The first
   * run for a player fetches all 50 from Riot; later runs only fetch games not cached yet.
   * Without a champion it picks their most played one.
   */
  async champ(player: PlayerRow, championInput?: string, queueId?: number): Promise<Reply> {
    return this.fresh(player, (p) => this.champImpl(p, championInput, queueId));
  }

  private async champImpl(player: PlayerRow, championInput: string | undefined, queueId: number | undefined): Promise<Reply> {
    const q = queueId === undefined ? undefined : await this.resolveQueue(queueId, player);
    const ids = await this.riot.getMatchIds(player.platform, player.puuid, q === undefined ? { count: CHAMP_SAMPLE, type: 'ranked' } : { count: CHAMP_SAMPLE, queue: q });
    let fetched = 0;
    const matches = (await Promise.all(ids.map(async (id) => {
      const cached = this.repo.getCachedMatch(id);
      if (cached) return cached;
      const m = await this.riot.getMatch(player.platform, id).catch(() => null);
      if (m) {
        this.repo.cacheMatch(m);
        fetched++;
      }
      return m;
    }))).filter((m): m is MatchDto => !!m);
    if (fetched) this.log(`champ: fetched ${fetched} matches for ${player.game_name}#${player.tag_line}`);

    const mine = matches
      .map((m) => ({ m, me: m.info.participants.find((x) => x.puuid === player.puuid) }))
      .filter((x): x is { m: MatchDto; me: ParticipantDto } => !!x.me && !x.me.gameEndedInEarlySurrender && x.m.info.gameDuration > 300);
    if (!mine.length) throw new UserError(`No ranked games found for **${player.game_name}#${player.tag_line}**.`);

    const sd = this.assets ? await this.assets.staticData('').catch(() => null) : null;
    let championId: number;
    if (championInput?.trim()) {
      const found = findChampion(championInput, sd, mine.map((x) => ({ id: x.me.championId, name: x.me.championName })));
      if (!found) throw new UserError(`I don't know a champion called **${championInput}**.`);
      championId = found;
    } else {
      const counts = new Map<number, number>();
      for (const x of mine) counts.set(x.me.championId, (counts.get(x.me.championId) ?? 0) + 1);
      championId = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
    }
    const on = mine.filter((x) => x.me.championId === championId).sort((a, b) => (b.m.info.gameEndTimestamp ?? 0) - (a.m.info.gameEndTimestamp ?? 0));
    const info = sd?.champions.get(championId);
    const champName = info?.name ?? mine.find((x) => x.me.championId === championId)?.me.championName ?? championInput ?? '?';
    if (!on.length) {
      throw new UserError(`**${player.game_name}#${player.tag_line}** has no ${champName} games in their last ${mine.length} ranked games.`);
    }

    const avg = (f: (x: (typeof on)[number]) => number) => on.reduce((s, x) => s + f(x), 0) / on.length;
    const mins = (x: (typeof on)[number]) => Math.max(1, x.m.info.gameDuration / 60);
    const kps = on.map((x) => x.me.challenges?.killParticipation).filter((v): v is number => typeof v === 'number');
    const games: ChampGame[] = on.map((x) => {
      const pm = this.repo.getPlayerMatch(x.m.metadata.matchId, player.puuid);
      const cs = x.me.totalMinionsKilled + x.me.neutralMinionsKilled;
      return {
        win: x.me.win, kills: x.me.kills, deaths: x.me.deaths, assists: x.me.assists,
        cs, csPerMin: cs / mins(x), damage: x.me.totalDamageDealtToChampions, role: x.me.teamPosition,
        endedAt: x.m.info.gameEndTimestamp ?? x.m.info.gameStartTimestamp + x.m.info.gameDuration * 1000,
        queue: queueName(x.m.info.queueId),
        lpDelta: pm?.status === 'done' ? pm.lp_delta : null,
      };
    });
    const k = avg((x) => x.me.kills), d = avg((x) => x.me.deaths), a = avg((x) => x.me.assists);
    const lpGames = games.filter((g) => g.lpDelta !== null);
    const roles = new Map<string, number>();
    for (const x of on) if (x.me.teamPosition) roles.set(x.me.teamPosition, (roles.get(x.me.teamPosition) ?? 0) + 1);
    const card: ChampCard = {
      player: player.game_name, tag: player.tag_line,
      championId, championKey: info?.id ?? champName.replace(/[^A-Za-z]/g, ''), championName: champName,
      sampleSize: mine.length,
      games,
      totals: {
        kda: d ? (k + a) / d : k + a, k, d, a,
        csPerMin: avg((x) => (x.me.totalMinionsKilled + x.me.neutralMinionsKilled) / mins(x)),
        dmgPerMin: avg((x) => x.me.totalDamageDealtToChampions / mins(x)),
        kp: kps.length ? kps.reduce((s, v) => s + v, 0) / kps.length : null,
        visionPerMin: avg((x) => x.me.visionScore / mins(x)),
        lp: lpGames.length ? lpGames.reduce((s, g) => s + g.lpDelta!, 0) : null,
        lpGames: lpGames.length,
      },
      mainRole: [...roles].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null,
      multikills: { penta: on.reduce((s, x) => s + x.me.pentaKills, 0), quadra: on.reduce((s, x) => s + x.me.quadraKills, 0), triple: on.reduce((s, x) => s + x.me.tripleKills, 0) },
    };
    const png = await renderChamp(card, this.assets, sd, this.now());
    return {
      embed: { color: 0x5865f2, image: { url: 'attachment://champ.png' }, ...(fetched >= 10 ? { footer: { text: `Fetched ${fetched} games from Riot for this; next time it's instant.` } } : {}) },
      files: [{ name: 'champ.png', data: png }],
      components: [linkButtonRow(profileLinks(player.platform, player.game_name, player.tag_line))],
    };
  }

  // ---- rank changes, /peak, recap awards ----

  /** Promotions / demotions out of resolved games and LP adjustments (decay, dodges). */
  rankChanges(games: GameResult[], adjustments: LpAdjustment[]): RankChange[] {
    const out: RankChange[] = [];
    const add = (player: PlayerRow, queueType: string | undefined, from: Rank | null | undefined, to: Rank | null | undefined) => {
      if (!queueType || !from || !to) return;
      const c = compareDivision(to, from);
      if (c !== 0) out.push({ player, queueType, from, to, up: c > 0 });
    };
    for (const g of games) add(g.player, QUEUE_TYPE_BY_ID[g.queueId], g.rankBefore, g.rankAfter);
    for (const a of adjustments) add(a.player, a.queueType, a.rankBefore, a.rankAfter);
    return out;
  }

  /** Post promotions / demotions to the game log channels that show this player. */
  async postRankChanges(changes: RankChange[]): Promise<void> {
    if (!this.logPoster || !changes.length) return;
    for (const ch of changes) {
      const channels = new Set<string>();
      if (this.gameLogChannel) channels.add(this.gameLogChannel);
      for (const g of this.repo.listGuilds()) {
        if (g.log_channel_id && this.repo.trackedInGuild(g.guild_id).some((p) => p.puuid === ch.player.puuid)) channels.add(g.log_channel_id);
      }
      if (!channels.size) continue;
      const reply = await this.rankChangeReply(ch);
      for (const c of channels) {
        await this.logPoster.send(c, reply).catch((e) => this.log(`rank change post to ${c} failed: ${(e as Error).message}`));
      }
    }
  }

  private async rankChangeReply(ch: RankChange): Promise<Reply> {
    const emblem = this.assets ? await this.assets.emblemUrl(ch.to.tier).catch(() => null) : null;
    const who = `${ch.player.game_name}#${ch.player.tag_line}`;
    return {
      embed: {
        title: `${ch.up ? '🎉' : '📉'} ${who} ${ch.up ? 'promoted' : 'demoted'} to ${formatTierDiv(ch.to)}`,
        description: `${formatTierDiv(ch.from)} → **${formatTierDiv(ch.to)}** · ${QUEUE_TYPE_LABEL[ch.queueType] ?? ch.queueType}`,
        color: ch.up ? 0x3fb950 : 0xf85149,
        ...(emblem && /^https?:/.test(emblem) ? { thumbnail: { url: emblem } } : {}),
      },
      files: [],
    };
  }

  /** /peak: highest rank per queue since tracking started (recorded games + current rank). */
  async peak(player: PlayerRow): Promise<Reply> {
    const best = new Map<string, { r: Rank; at: number }>();
    const consider = (qt: string | undefined, r: Rank, at: number) => {
      if (!qt) return;
      const cur = best.get(qt);
      if (!cur || compareDivision(r, cur.r) > 0 || (compareDivision(r, cur.r) === 0 && r.lp > cur.r.lp)) best.set(qt, { r, at });
    };
    for (const h of this.repo.rankHistory(player.puuid)) consider(QUEUE_TYPE_BY_ID[h.queue_id], h, h.at);
    const now: Record<string, Rank> = {};
    for (const s of this.repo.getSnapshots(player.puuid)) {
      if (!s.tier || s.tier === 'UNRANKED' || !QUEUE_TYPE_LABEL[s.queue_type]) continue;
      now[s.queue_type] = { tier: s.tier, division: s.division, lp: s.lp };
      consider(s.queue_type, now[s.queue_type]!, s.taken_at);
    }
    const order = ['RANKED_SOLO_5x5', 'RANKED_FLEX_SR', 'RANKED_PREMADE_5x5'].filter((q) => best.has(q));
    if (!order.length) throw new UserError(`No ranked games recorded for **${player.game_name}#${player.tag_line}** yet.`);
    const top = order.map((q) => best.get(q)!.r).sort((a, b) => compareDivision(b, a) || b.lp - a.lp)[0]!;
    const emblem = this.assets ? await this.assets.emblemUrl(top.tier).catch(() => null) : null;
    const ts = (ms: number) => `<t:${Math.floor(ms / 1000)}:D>`;
    return {
      embed: {
        title: `Peak ranks · ${player.game_name}#${player.tag_line}`,
        color: 0x5865f2,
        ...(emblem && /^https?:/.test(emblem) ? { thumbnail: { url: emblem } } : {}),
        fields: order.map((q) => {
          const b = best.get(q)!;
          const n = now[q];
          const atPeak = n && compareDivision(n, b.r) === 0 && n.lp >= b.r.lp;
          return {
            name: QUEUE_TYPE_LABEL[q]!,
            value: `**${formatTierDiv(b.r)} · ${b.r.lp} LP** · ${ts(b.at)}\n${atPeak ? '🔥 at peak right now' : n ? `now ${formatTierDiv(n)} · ${n.lp} LP` : ''}`,
            inline: true,
          };
        }),
        footer: { text: `Since tracking started · ${new Date(player.created_at).toISOString().slice(0, 10)}` },
      },
      files: [],
      components: [linkButtonRow(profileLinks(player.platform, player.game_name, player.tag_line))],
    };
  }

  /**
   * Recap awards: single-game highlights among the tracked accounts in a period, plus
   * promotions / demotions over it. Null when nobody played.
   */
  async recapAwards(list: PlayerRow[], period: Period, title: string): Promise<Reply | null> {
    const queues = await this.recapQueues();
    const qset = new Set(queues);
    type G = { p: PlayerRow; me: ParticipantDto; m: MatchDto; lp: number | null };
    const gs: G[] = [];
    for (const p of list) {
      for (const row of this.repo.doneMatchesBetween(p.puuid, period.from, period.to)) {
        if (row.remake || !qset.has(row.queue_id)) continue;
        const m = this.repo.getCachedMatch(row.match_id);
        const me = m?.info.participants.find((x) => x.puuid === p.puuid);
        if (m && me) gs.push({ p, me, m, lp: row.lp_delta });
      }
    }
    const changes: string[] = [];
    for (const p of list) {
      for (const q of queues) {
        const qt = QUEUE_TYPE_BY_ID[q];
        const from = this.repo.rankBefore(p.puuid, [q], period.from);
        const to = this.repo.rankBefore(p.puuid, [q], period.to);
        if (!qt || !from || !to) continue;
        const c = compareDivision(to, from);
        if (c) changes.push(`${c > 0 ? '📈' : '📉'} **${p.game_name}** ${formatTierDiv(from)} → **${formatTierDiv(to)}** (${queueName(q)})`);
      }
    }
    if (!gs.length && !changes.length) return null;

    const mins = (g: G) => Math.max(1, g.m.info.gameDuration / 60);
    const kda = (g: G) => (g.me.kills + g.me.assists) / Math.max(1, g.me.deaths);
    const cs = (g: G) => g.me.totalMinionsKilled + g.me.neutralMinionsKilled;
    const who = (g: G) => `**${g.p.game_name}** (${g.me.championName})`;
    const pick = (score: (g: G) => number, ok: (g: G) => boolean = () => true) => {
      const c = gs.filter(ok);
      return c.length ? c.reduce((a, b) => (score(b) > score(a) ? b : a)) : null;
    };
    const lines: string[] = [];
    const award = (label: string, g: G | null, text: (g: G) => string) => { if (g) lines.push(`${label} ${who(g)} · ${text(g)}`); };
    award('🗡️ **Most kills**', pick((g) => g.me.kills, (g) => g.me.kills > 0), (g) => `${g.me.kills} kills`);
    award('🎯 **Best KDA**', pick(kda), (g) => `${g.me.kills}/${g.me.deaths}/${g.me.assists}`);
    award('💀 **Most deaths**', pick((g) => g.me.deaths, (g) => g.me.deaths > 0), (g) => `${g.me.deaths} deaths`);
    award('💥 **Most damage**', pick((g) => g.me.totalDamageDealtToChampions), (g) => `${g.me.totalDamageDealtToChampions.toLocaleString('en-US')} to champions`);
    award('🌾 **Best farmer**', pick((g) => cs(g) / mins(g), (g) => g.me.teamPosition !== 'UTILITY'), (g) => `${(cs(g) / mins(g)).toFixed(1)} CS/min`);
    award('👁️ **Most vision**', pick((g) => g.me.visionScore), (g) => `${g.me.visionScore} vision score`);
    award('⏱️ **Longest game**', pick((g) => g.m.info.gameDuration), (g) => `${Math.floor(g.m.info.gameDuration / 60)}:${String(g.m.info.gameDuration % 60).padStart(2, '0')}`);
    const pentas = gs.filter((g) => g.me.pentaKills > 0);
    if (pentas.length) lines.push(`🏆 **PENTAKILL** ${pentas.map(who).join(', ')}`);

    return {
      embed: {
        title,
        color: 0xf5c542,
        description: lines.join('\n') || undefined,
        ...(changes.length ? { fields: [{ name: 'Rank changes', value: changes.slice(0, 15).join('\n') }] } : {}),
      },
      files: [],
    };
  }

  /** Totals for /zeke. */
  stats(): { players: number; linkedUsers: number } {
    return { players: this.repo.activePlayers().length, linkedUsers: this.repo.linkedUserCount() };
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
  /**
   * /scout with several players (2–5, one region): each scouted from their own recent
   * ranked games, for teams that aren't a fixed five-stack.
   */
  async scoutMany(riotIdInputs: string[], regionInput?: string): Promise<Reply> {
    const inputs = [...new Map(riotIdInputs.map((x) => [x.trim().toLowerCase(), x.trim()])).values()].filter(Boolean);
    if (inputs.length <= 1) return this.banPlan(inputs[0] ?? '', regionInput);
    if (inputs.length > 5) throw new UserError('Scout up to 5 players at once.');
    const platform = regionInput ? parsePlatform(regionInput) : null;
    if (regionInput && !platform) throw new UserError(`Unknown region "${regionInput}". Use one of: ${Object.values(PLATFORM_LABEL).join(', ')}`);
    const players: { puuid: string; name: string; tag: string; platform: Platform }[] = [];
    const missing: string[] = [];
    for (const input of inputs) {
      let id;
      try {
        id = parseRiotId(input);
      } catch (e) {
        throw new UserError(`${(e as Error).message} (${input})`);
      }
      const known = this.repo.findPlayerByRiotId(id.gameName, id.tagLine, platform ?? undefined);
      const plat = platform ?? known?.platform ?? (this.defaultRegion ? parsePlatform(this.defaultRegion) : null);
      if (!plat) throw new UserError('Add the region, e.g. `EUNE`.');
      const re = known ? await this.tracker.rekey(known).catch(() => null) : null;
      if (re) {
        players.push({ puuid: re.puuid, name: re.game_name, tag: re.tag_line, platform: plat });
        continue;
      }
      const acc = await this.riot.getAccountByRiotId(plat, id.gameName, id.tagLine);
      if (!acc) missing.push(formatRiotId(id));
      else players.push({ puuid: acc.puuid, name: acc.gameName ?? id.gameName, tag: acc.tagLine ?? id.tagLine, platform: plat });
    }
    if (missing.length) throw new UserError(`Riot ID${missing.length > 1 ? 's' : ''} not found: **${missing.join('**, **')}**. Check the spelling and region.`);
    const report = await scoutPlayers(this.repo, this.riot, players, { log: this.log });
    if (report.sample < 3) throw new UserError(`Only ${report.sample} ranked games found for these players. Wrong region?`);
    const png = await renderBanPlan(report, this.assets);
    const bans = report.priorityBans.map((b) => b.championName).join(', ');
    return {
      embed: { color: 0xe74c3c, image: { url: 'attachment://scout.png' }, footer: { text: bans ? `Priority bans: ${bans}` : 'No ban suggestions' } },
      files: [{ name: 'scout.png', data: png }],
    };
  }

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
      // "~3 wins to Diamond IV": average LP per win over the last recorded wins in this queue
      const qid = queueType === 'RANKED_FLEX_SR' ? FLEX : queueType === 'RANKED_SOLO_5x5' ? SOLO : await this.resolveQueue(FIVES);
      const gains = this.repo.lpHistory(player.puuid, qid, 30)
        .filter((r) => r.win && !r.remake && typeof r.lp_delta === 'number' && r.lp_delta > 0 && (r.note === null || r.note === 'exact'))
        .slice(-15).map((r) => r.lp_delta!);
      const tn = winsToNext(rank, gains);
      const toNext = tn ? `~${tn.wins} win${tn.wins === 1 ? "" : "s"} to ${formatTierDiv({ ...tn.next, lp: 0 })}` : null;
      return { label, rank, wins: e.wins, losses: e.losses, ladderPos, hotStreak: e.hotStreak, toNext };
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
      components: [linkButtonRow(profileLinks(player.platform, player.game_name, player.tag_line))],
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
      // Not polled yet: if it's a tracked queue after tracking began, LP is on its way.
      const gameEnd = match.info.gameEndTimestamp ?? match.info.gameStartTimestamp + match.info.gameDuration * 1000;
      r.note = !qt ? 'norank' : !pm && gameEnd >= player.created_at && !remake ? 'pending' : 'unrecorded';
    }
    const reply = await this.gameReply(r);
    if (r.note === 'pending') reply.watch = { matchId: id, puuid: player.puuid };
    return reply;
  }

  // ---- /recent replies waiting for LP ----
  private recentWatchers = new Map<string, { edit: (r: Reply) => Promise<unknown>; expires: number }[]>();

  /** Edit a /recent message once its game's LP is in (ttl: how long the message can still be edited). */
  watchRecent(watch: { matchId: string; puuid: string }, edit: (r: Reply) => Promise<unknown>, ttlMs: number): void {
    const key = `${watch.matchId}:${watch.puuid}`;
    this.recentWatchers.set(key, [...(this.recentWatchers.get(key) ?? []), { edit, expires: this.now() + ttlMs }]);
  }

  private async updateRecentWatchers(games: GameResult[]): Promise<void> {
    const now = this.now();
    for (const [key, list] of this.recentWatchers) {
      const live = list.filter((w) => w.expires > now);
      if (live.length) this.recentWatchers.set(key, live);
      else this.recentWatchers.delete(key);
    }
    for (const g of games) {
      const key = `${g.match.metadata.matchId}:${g.player.puuid}`;
      const list = this.recentWatchers.get(key);
      if (!list) continue;
      this.recentWatchers.delete(key);
      const reply = await this.recentImpl(g.player, undefined, g.match.metadata.matchId).catch(() => null);
      if (!reply) continue;
      for (const w of list) {
        await w.edit(reply).catch((e) => this.log(`recent: could not update message for ${key}: ${(e as Error).message}`));
      }
    }
  }

  /**
   * Game embed with the rendered scoreboard image. Falls back to the text
   * scoreboard if rendering fails (missing native module, bad data…).
   */
  async gameReply(r: GameResult, alsoTracked: Set<string> = new Set()): Promise<Reply> {
    const reply = await this.gameReplyBody(r, alsoTracked);
    reply.components = [linkButtonRow(matchLinks(r.player.platform, r.player.game_name, r.player.tag_line, r.match.metadata.matchId))];
    return reply;
  }

  private async gameReplyBody(r: GameResult, alsoTracked: Set<string>): Promise<Reply> {
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
    // Show the rank for the queue being played; Solo/Duo for normals, ARAM etc.
    const q = g.gameQueueConfigId ?? 0;
    const rankQueue = q === FLEX ? 'RANKED_FLEX_SR' : isFivesQueue(q) ? 'RANKED_PREMADE_5x5' : 'RANKED_SOLO_5x5';
    const rankLabel = q === FLEX ? 'FLEX' : isFivesQueue(q) ? 'RANKED 5S' : 'SOLO/DUO';
    const parties = await this.liveParties(player.platform, g, player.puuid);
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
        rank: rank(entries[i]!, rankQueue),
        focus: p.puuid === player.puuid,
        party: parties[i] ?? null,
        known: !!known && p.puuid !== player.puuid,
      };
    });
    const queueLabel = (q && QUEUE_LABEL[q]) || (g.gameMode === 'CLASSIC' ? 'Summoner\'s Rift' : g.gameMode.charAt(0) + g.gameMode.slice(1).toLowerCase());
    // gameLength is only refreshed now and then; time since gameStartTime is more current.
    const seconds = g.gameStartTime > 0 ? Math.max(0, Math.round((this.now() - g.gameStartTime) / 1000)) : null;
    const history = this.lobbyHistory(player, g);
    if (!this.assets) throw new UserError('Live games need images, which are turned off on this bot.');
    const png = await renderLive({ queueLabel, rankLabel, seconds, bans: g.bannedChampions, players }, this.assets);
    return {
      embed: {
        color: 0xf85149,
        ...(history ? { description: history } : {}),
        image: { url: 'attachment://live.png' },
        footer: { text: `${player.game_name}#${player.tag_line} · ${PLATFORM_LABEL[player.platform]}` },
      },
      files: [{ name: 'live.png', data: png }],
      components: [linkButtonRow(liveGameLinks(player.platform, player.game_name, player.tag_line))],
    };
  }

  /**
   * /live lobby history: who in this game the player has met before (cached games), as
   * teammate or opponent, with the player's W/L in those games.
   */
  private lobbyHistory(player: PlayerRow, g: CurrentGameInfo): string | null {
    const others = g.participants.filter((p) => p.puuid && p.puuid !== player.puuid);
    if (!others.length) return null;
    const stats = new Map<string, { withW: number; withL: number; vsW: number; vsL: number }>();
    for (const m of this.repo.cachedMatchesWith(player.puuid)) {
      if (m.metadata.matchId.endsWith(`_${g.gameId}`)) continue;
      const me = m.info.participants.find((x) => x.puuid === player.puuid);
      if (!me || me.gameEndedInEarlySurrender) continue;
      for (const o of others) {
        const them = m.info.participants.find((x) => x.puuid === o.puuid);
        if (!them) continue;
        const s = stats.get(o.puuid!) ?? { withW: 0, withL: 0, vsW: 0, vsL: 0 };
        if (them.teamId === me.teamId) me.win ? s.withW++ : s.withL++;
        else me.win ? s.vsW++ : s.vsL++;
        stats.set(o.puuid!, s);
      }
    }
    if (!stats.size) return null;
    const nameOf = (puuid: string) => {
      const p = g.participants.find((x) => x.puuid === puuid);
      const rid = p?.riotId ?? '';
      return rid.includes('#') ? rid.slice(0, rid.lastIndexOf('#')) : rid || this.repo.getPlayer(puuid)?.game_name || 'someone';
    };
    const fmt = (n: number, w: number, l: number) => `${n}× (${w}W ${l}L)`;
    const withs: string[] = [];
    const vs: string[] = [];
    // most games first
    for (const [puuid, s] of [...stats].sort((a, b) => (b[1].withW + b[1].withL + b[1].vsW + b[1].vsL) - (a[1].withW + a[1].withL + a[1].vsW + a[1].vsL))) {
      const w = s.withW + s.withL, v = s.vsW + s.vsL;
      if (w) withs.push(`**${nameOf(puuid)}** ${fmt(w, s.withW, s.withL)}`);
      if (v) vs.push(`**${nameOf(puuid)}** ${fmt(v, s.vsW, s.vsL)}`);
    }
    return [
      withs.length ? `🤝 Played with ${withs.slice(0, 5).join(' · ')}` : '',
      vs.length ? `⚔️ Played against ${vs.slice(0, 5).join(' · ')}` : '',
    ].filter(Boolean).join('\n') || null;
  }

  /**
   * Premades in a live game: Riot doesn't expose parties, so teammates who were on the same
   * side in 2+ of each other's last 10 games count as queued together. Returns a party
   * number (0–3) per participant, or null for solo players.
   */
  private async liveParties(platform: Platform, g: CurrentGameInfo, focusPuuid?: string): Promise<(number | null)[]> {
    const ps = g.participants;
    const lists = await Promise.all(ps.map((p) =>
      p.puuid && !p.bot ? this.riot.getMatchIds(platform, p.puuid, { count: 10 }).catch(() => [] as string[]) : Promise.resolve([] as string[])));
    // the focus player's last 10 games feed the lobby history: make sure they're cached
    const fi = ps.findIndex((p) => p.puuid === focusPuuid);
    if (fi >= 0) {
      await Promise.all(lists[fi]!.filter((id) => !this.repo.getCachedMatch(id)).map(async (id) => {
        const m = await this.riot.getMatch(platform, id).catch(() => null);
        if (m) this.repo.cacheMatch(m);
      }));
    }
    const parent = ps.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    const loadMatch = async (id: string) => {
      const c = this.repo.getCachedMatch(id);
      if (c) return c;
      const m = await this.riot.getMatch(platform, id).catch(() => null);
      if (m) this.repo.cacheMatch(m);
      return m;
    };
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        if (ps[i]!.teamId !== ps[j]!.teamId || !lists[i]!.length || !lists[j]!.length || find(i) === find(j)) continue;
        const shared = lists[i]!.filter((id) => lists[j]!.includes(id));
        if (shared.length < 2) continue;
        let together = 0;
        for (const id of shared) {
          const m = await loadMatch(id);
          const a = m?.info.participants.find((x) => x.puuid === ps[i]!.puuid);
          const b = m?.info.participants.find((x) => x.puuid === ps[j]!.puuid);
          if (a && b && a.teamId === b.teamId && ++together >= 2) break;
        }
        if (together >= 2) parent[find(i)] = find(j);
      }
    }
    // groups of 2+, numbered in lobby order (blue team first)
    const size = new Map<number, number>();
    ps.forEach((_, i) => size.set(find(i), (size.get(find(i)) ?? 0) + 1));
    const num = new Map<number, number>();
    return ps.map((_, i) => {
      const root = find(i);
      if ((size.get(root) ?? 0) < 2) return null;
      if (!num.has(root)) num.set(root, num.size);
      return num.get(root)! < 4 ? num.get(root)! : null;
    });
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

  // ---- daily recap (scheduled) ----

  /** Where the scheduled recap goes; unset = off (e.g. tests, CLI). */
  private recapPoster: ((channelId: string, replies: Reply[]) => Promise<void>) | null = null;
  setRecapPoster(fn: ((channelId: string, replies: Reply[]) => Promise<void>) | null) {
    this.recapPoster = fn;
  }

  /** Turn the daily recap on for a channel (or off with null). Today's not-yet-finished day is the first one posted. */
  setRecapChannel(guildId: string, channelId: string | null): GuildRow {
    const g = this.guild(guildId);
    this.repo.setRecapChannel(guildId, channelId, previousDay(this.now(), g.timezone).to);
    return this.guild(guildId);
  }

  /**
   * The recap for one finished local day: one leaderboard per queue anyone played in,
   * covering exactly that day. A quiet day gets a one-line "no games" post.
   */
  async dailyRecap(guildId: string, period: Period): Promise<Reply[]> {
    const g = this.guild(guildId);
    const list = this.repo.trackedInGuild(guildId);
    const out: Reply[] = [];
    for (const q of await this.recapQueues()) {
      if (!digestFor(this.repo, list, 'adhoc', period, q).players.some((p) => p.games > 0)) continue;
      out.push(await this.leaderboardFor(list, g.timezone, 'daily', q, { title: `Daily recap · ${queueName(q)}`, none: '', who: 'tracked account' }, period));
    }
    if (out.length) out.push(await this.gamesLeaderboard(list, period, 'Games played today'));
    const awards = await this.recapAwards(list, period, '🏅 Today\'s awards');
    if (awards) out.push(awards);
    if (!out.length) {
      out.push({
        embed: {
          title: `Daily recap · ${period.label}`,
          description: list.length ? `No ranked games by the ${list.length} tracked account${list.length === 1 ? '' : 's'} today. 💤` : 'No accounts tracked in this server yet. Use `/track add`.',
          color: 0x5865f2,
        },
        files: [],
      });
    }
    return out;
  }

  /** Weekly recap (Monday, after the daily one): the past Mon–Sun per queue, then games played. */
  async weeklyRecap(guildId: string, period: Period): Promise<Reply[]> {
    const g = this.guild(guildId);
    const list = this.repo.trackedInGuild(guildId);
    const out: Reply[] = [];
    for (const q of await this.recapQueues()) {
      if (!digestFor(this.repo, list, 'adhoc', period, q).players.some((p) => p.games > 0)) continue;
      out.push(await this.leaderboardFor(list, g.timezone, 'weekly', q, { title: `Weekly recap · ${queueName(q)}`, none: '', who: 'tracked account' }, period));
    }
    if (out.length) out.push(await this.gamesLeaderboard(list, period, 'Games played this week'));
    const awards = await this.recapAwards(list, period, '🏅 This week\'s awards');
    if (awards) out.push(awards);
    return out;
  }

  private async recapQueues(): Promise<number[]> {
    return [SOLO, FLEX, ...(await this.resolveQueue(FIVES).then((q) => (q === FIVES ? [] : [q])))];
  }

  /** "Most games played" across Solo/Duo, Flex and 5s in a period (remakes excluded). */
  async gamesLeaderboard(list: PlayerRow[], period: Period, title: string): Promise<Reply> {
    const queues = new Set(await this.recapQueues());
    const rows: GamesRow[] = [];
    for (const p of list) {
      const ms = this.repo.doneMatchesBetween(p.puuid, period.from, period.to).filter((m) => !m.remake && queues.has(m.queue_id));
      if (!ms.length) continue;
      const byQueue = new Map<string, number>();
      const champs = new Map<number, { id: number; name: string; version: string; n: number }>();
      for (const m of ms) {
        byQueue.set(queueName(m.queue_id), (byQueue.get(queueName(m.queue_id)) ?? 0) + 1);
        const match = this.repo.getCachedMatch(m.match_id);
        const me = match?.info.participants.find((x) => x.puuid === p.puuid);
        if (me && match) {
          const c = champs.get(me.championId) ?? { id: me.championId, name: me.championName, version: match.info.gameVersion, n: 0 };
          c.n++;
          champs.set(me.championId, c);
        }
      }
      const wins = ms.filter((m) => m.win).length;
      const top = [...champs.values()].sort((a, b) => b.n - a.n)[0];
      rows.push({ name: p.game_name, tag: p.tag_line, games: ms.length, wins, losses: ms.length - wins, byQueue: [...byQueue], champ: top ? { id: top.id, name: top.name, version: top.version } : null });
    }
    rows.sort((a, b) => b.games - a.games || b.wins - a.wins);
    const shown = rows.slice(0, 20);
    const sd = this.assets ? await this.assets.staticData(shown.find((r) => r.champ)?.champ?.version ?? '99.99').catch(() => null) : null;
    const png = await renderGamesBoard(shown, { title, subtitle: rows.length > 20 ? `${period.label} · top 20 of ${rows.length}` : period.label, hiddenCount: list.length - rows.length }, this.assets, sd);
    return { embed: { color: 0xf5c542, image: { url: 'attachment://games.png' } }, files: [{ name: 'games.png', data: png }] };
  }

  /**
   * Post every recap that's due: the local day that just ended (10 min after midnight), once per guild. If the bot
   * was down at midnight it catches up within 6h; older days are skipped, not spammed.
   */
  async postDueRecaps(): Promise<void> {
    if (!this.recapPoster) return;
    const now = this.now();
    for (const g of this.repo.recapGuilds()) {
      const day = previousDay(now, g.timezone);
      if (g.recap_posted_to >= day.to) continue;
      // Wait a few minutes past midnight so games that ended just before it have their LP.
      if (now < day.to + RECAP_DELAY_MS) continue;
      this.repo.markRecapPosted(g.guild_id, day.to); // before sending: a failure never double-posts
      if (now - day.to > 6 * 3_600_000) continue;
      try {
        await this.recapPoster(g.recap_channel_id!, await this.dailyRecap(g.guild_id, day));
        this.log(`recap: posted ${day.key} to guild ${g.guild_id}`);
        // The day that just ended is a Sunday: the weekly recap follows.
        if (zonedParts(day.to, g.timezone).weekday === 1) {
          const week = previousWeek(day.to, g.timezone);
          const weekly = await this.weeklyRecap(g.guild_id, week);
          if (weekly.length) await this.recapPoster(g.recap_channel_id!, weekly);
        }
      } catch (e) {
        this.log(`recap: guild ${g.guild_id} failed: ${(e as Error).message}`);
      }
    }
  }

  /** Admin: leaderboard across every account the bot knows (all servers, links and lookups). */
  async globalLeaderboard(kind: 'daily' | 'weekly', queueId = SOLO): Promise<Reply> {
    return this.leaderboardFor(this.repo.activePlayers(), this.defaultTz, kind, queueId, {
      title: `Global leaderboard · ${recapTitle(kind)} · ${queueName(queueId)}`,
      none: 'No accounts known yet.',
      who: 'known account',
    });
  }

  private async leaderboardFor(list: PlayerRow[], tz: string, kind: 'daily' | 'weekly', queueId: number, text: { title: string; none: string; who: string }, fixed?: Period): Promise<Reply> {
    const period = fixed ?? recapWindow(kind, this.now(), tz);
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
  /** Ticks run one at a time (regular poll and the fast LP check share state). */
  private busy: Promise<unknown> = Promise.resolve();
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => undefined);
    return run;
  }

  /** Regular poll: new games for every due account, then LP for pending ones. */
  async tick(): Promise<{ games: number; requests: number }> {
    return this.exclusive(async () => {
      const { games, adjustments, requests, detected } = await this.tracker.tick();
      await this.afterTick(games, adjustments, detected);
      await this.postDueRecaps();
      return { games: games.length, requests };
    });
  }

  /** Fast LP check (every LP_CHECK_SEC): only accounts with a game waiting for LP. */
  async lpTick(): Promise<{ games: number; requests: number }> {
    return this.exclusive(async () => {
      const { games, adjustments, requests } = await this.tracker.checkPending();
      if (games.length || adjustments.length) await this.afterTick(games, adjustments, []);
      return { games: games.length, requests };
    });
  }

  private async afterTick(games: GameResult[], adjustments: LpAdjustment[], detected: string[]): Promise<void> {
    await this.postRankChanges(this.rankChanges(games, adjustments));
    for (const g of games) {
      const guilds = this.repo.guildsTracking(g.player.puuid);
      // Linked-only players have no guild; still surface them to the sink under a pseudo-guild.
      if (!guilds.length) guilds.push({ guild_id: 'linked', log_channel_id: null, timezone: this.defaultTz, created_at: 0, recap_channel_id: null, recap_posted_to: 0 });
      for (const guild of guilds) {
        if (guild.guild_id !== 'linked' && !this.repo.markPosted(guild.guild_id, g.match.metadata.matchId, g.player.puuid)) continue;
        const others = new Set(this.repo.trackedInGuild(guild.guild_id).map((p) => p.puuid).filter((x) => x !== g.player.puuid));
        await this.sink.send(guild, 'game', [buildGameEmbed(g, others)], { label: `${g.match.metadata.matchId}-${g.player.game_name}` });
      }
    }
    // New games are posted right away; resolved ones edit their post with the LP.
    await this.postGameLogs([...detected, ...games.map((g) => g.match.metadata.matchId)]);
    await this.updateRecentWatchers(games);
    for (const a of adjustments) {
      for (const guild of this.repo.guildsTracking(a.player.puuid)) {
        await this.sink.send(guild, 'notice', [buildAdjustmentEmbed(a.player.game_name, a.queueType, a.delta, formatRank(a.rankBefore), formatRank(a.rankAfter))], { label: `adj-${a.player.game_name}` });
      }
    }
  }

  /**
   * Game logs: a match is posted as soon as it's spotted (LP still pending) and the same
   * message is edited when LP comes in. One post per match and log, shared by every known
   * account in it; state lives in `posts`, so restarts never repost.
   */
  async postGameLogs(matchIds: string[]): Promise<void> {
    if (!this.logPoster || !matchIds.length) return;
    const targets: { key: string; channelId: string; include: (puuid: string) => boolean }[] = [];
    if (this.gameLogChannel) targets.push({ key: GAME_LOG_KEY, channelId: this.gameLogChannel, include: () => true });
    for (const g of this.repo.listGuilds().filter((x) => x.log_channel_id)) {
      const tracked = new Set(this.repo.trackedInGuild(g.guild_id).map((p) => p.puuid));
      targets.push({ key: `#log:${g.guild_id}`, channelId: g.log_channel_id!, include: (p) => tracked.has(p) });
    }
    if (!targets.length) return;
    const matches = [...new Set(matchIds)]
      .map((id) => ({ id, rows: this.repo.matchRows(id) }))
      .filter((m) => m.rows.length)
      .sort((a, b) => a.rows[0]!.game_end - b.rows[0]!.game_end);
    for (const m of matches) {
      for (const t of targets) {
        const rows = m.rows.filter((r) => t.include(r.puuid));
        if (rows.length) await this.postOrEditLog(t.key, t.channelId, m.id, rows);
      }
    }
  }

  private async postOrEditLog(key: string, channelId: string, matchId: string, rows: PlayerMatchRow[]): Promise<void> {
    const post = this.repo.getLogPost(key, matchId);
    if (post?.final) return;
    const done = rows.every((r) => r.status === 'done');
    try {
      const reply = await this.matchLogReply(matchId, rows);
      if (!reply) return;
      if (post?.message_id && post.channel_id) {
        await this.logPoster!.edit(post.channel_id, post.message_id, reply);
        this.repo.saveLogPost(key, matchId, post.channel_id, post.message_id, done);
      } else {
        const messageId = await this.logPoster!.send(channelId, reply);
        this.repo.saveLogPost(key, matchId, channelId, messageId, done);
      }
    } catch (e) {
      // Broken channel / deleted message: log it and stop trying for this match.
      this.log(`game log ${key}: could not post ${matchId}: ${(e as Error).message}`);
      this.repo.saveLogPost(key, matchId, post?.channel_id ?? channelId, post?.message_id ?? null, true);
    }
  }

  /** The log post for a match, rebuilt from the DB: first account is the focus, others listed. */
  private async matchLogReply(matchId: string, rows: PlayerMatchRow[]): Promise<Reply | null> {
    const match = this.repo.getCachedMatch(matchId);
    if (!match) return null;
    const results = rows
      .map((r) => {
        const player = this.repo.getPlayer(r.puuid);
        if (!player) return null;
        const g: GameResult = {
          player, match, queueId: r.queue_id, win: !!r.win, remake: !!r.remake,
          lpDelta: r.status === 'done' ? r.lp_delta : null,
          note: (r.status === 'pending' ? 'pending' : r.note) as GameResult['note'],
          rankBefore: null,
          rankAfter: r.tier_after ? { tier: r.tier_after, division: r.div_after ?? 'I', lp: r.lp_after ?? 0 } : null,
        };
        return g;
      })
      .filter((g): g is GameResult => !!g);
    if (!results.length) return null;
    const [first, ...rest] = results;
    const reply = await this.gameReply(first!, new Set(rest.map((g) => g.player.puuid)));
    if (rest.length) {
      const lines = rest.map((g) => `**${g.player.game_name}#${g.player.tag_line}** · ${g.remake ? 'Remake' : g.win ? 'Victory' : 'Defeat'}${g.lpDelta !== null ? ` · ${signed(g.lpDelta)} LP` : g.note === 'pending' ? ' · LP pending' : ''}`);
      reply.embed.description = `${reply.embed.description ?? ''}\nAlso in this game: ${lines.join(' · ')}`.trim();
    }
    return reply;
  }

  /** Turn the server's game log on for a channel (or off with null). Only games from now on are posted. */
  setLogChannel(guildId: string, channelId: string | null): GuildRow {
    this.guild(guildId);
    this.repo.setGuildChannel(guildId, channelId);
    return this.guild(guildId);
  }

  /** /server: tracked accounts, recap and game-log channels. */
  serverInfo(guildId: string, guildName?: string): Reply {
    const g = this.guild(guildId);
    const tracked = this.repo.trackedInGuild(guildId);
    const active = tracked.filter((p) => p.last_game_at && this.now() - p.last_game_at < 7 * 86_400_000).length;
    const ch = (id: string | null) => (id ? `<#${id}>` : '_off_');
    return {
      embed: {
        title: guildName ? `${guildName} · Zeke` : 'Server settings',
        color: 0x5865f2,
        fields: [
          { name: 'Tracked accounts', value: `**${tracked.length}**${tracked.length ? ` · ${active} played in the past 7 days` : ''}`, inline: true },
          { name: 'Timezone', value: g.timezone, inline: true },
          { name: 'Daily recap', value: `${ch(g.recap_channel_id)}${g.recap_channel_id ? ` · 00:${String(RECAP_DELAY_MS / 60_000).padStart(2, '0')} daily, weekly on Mondays` : ''}`, inline: false },
          { name: 'Game log', value: `${ch(g.log_channel_id)}${g.log_channel_id ? ' · every game of the tracked accounts' : ''}`, inline: false },
        ],
        footer: { text: 'Change with /recap and /log (Manage Server) · accounts with /track' },
      },
      files: [],
    };
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
