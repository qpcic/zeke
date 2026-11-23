import type { Repo } from '../db/repo.ts';
import { loadFivesQueue, saveFivesQueue } from './queues.ts';
import type { RiotClient } from '../riot/client.ts';
import type { Platform } from '../riot/regions.ts';
import type { MatchDto, ParticipantDto } from '../riot/types.ts';

/**
 * Pre-game scouting for premade 5v5 (Flex + Ranked 5s):
 *  1. last N team-queue games of the named player: Ranked 5s first, Flex fills the rest.
 *     Ranked 5s carries FIVES_WEIGHT (90%) of the total weight in every statistic below,
 *     Flex the remaining 10%; with only one queue present, all its games weigh the same.
 *  2. their team = the player + the 4 allies who show up most often
 *  3. each member's role = best overall assignment of their most played positions
 *  4. each member's bans = of their 10 most played champs, the 3 with the best winrate
 * Only games the team actually played (with the scouted player) are used.
 */

export const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'] as const;
export type Role = (typeof ROLES)[number];

/** games/wins are raw counts (shown, used for the min-games rule); wGames/wWins are queue-weighted (used for ranking). */
export interface ChampStat { championId: number; championName: string; games: number; wins: number; wGames: number; wWins: number; version: string }

/** Share of total weight given to Ranked 5s games when both queues are in the sample. */
export const FIVES_WEIGHT = 0.9;

/**
 * Ranking score for bans: queue-weighted winrate smoothed toward 50% by SMOOTH weight units.
 * Flex-only champs carry little weight, so they shrink toward 50%; Ranked 5s picks keep
 * their real winrate. With a single queue this is a mild Laplace smoothing.
 */
const SMOOTH = 6;
export function banScore(c: { games: number; wins: number; wGames?: number; wWins?: number }): number {
  const g = c.wGames ?? c.games, w = c.wGames !== undefined ? c.wWins ?? 0 : c.wins;
  return (w + SMOOTH / 2) / (g + SMOOTH);
}

/** Queue-weighted winrate (falls back to raw when weights are absent). */
export const winrate = (c: { games: number; wins: number; wGames?: number; wWins?: number }) =>
  c.wGames ? (c.wWins ?? 0) / c.wGames : c.games ? c.wins / c.games : 0;
export interface MemberReport {
  puuid: string;
  name: string;
  tag: string;
  role: Role | null;
  roleShare: number; // fraction of their games played in the assigned role
  games: number; // games in the sample (with the scouted player)
  wins: number;
  mostPlayed: ChampStat[]; // top 10 by raw games (display)
  bans: ChampStat[]; // top 3 winrate among mostPlayed
  isTarget: boolean;
  /** One-trick: most games on one champion (see markOtps) */
  otp?: { championName: string; share: number } | null;
}
export interface ScoutReport {
  target: { puuid: string; name: string; tag: string; platform: Platform };
  members: MemberReport[]; // ordered by role TOP..UTILITY, unassigned last
  priorityBans: (ChampStat & { owner: string; otp?: boolean })[];
  sample: number;
  queues: { flex: number; fives: number; solo?: number };
  /** per-game weight actually applied ({ fives: 1, flex: 1 } when only one queue is present) */
  weights: { fives: number; flex: number };
  fivesQueueId: number | null;
  premadeShare: number; // fraction of games where the 4 detected teammates were all present
  /** 'team': one player + their detected teammates; 'individual': players given by hand, each from their own games. */
  mode?: 'team' | 'individual';
  /** individual mode: games where 2+ of the given players were on the same team */
  together?: number;
  /** individual mode: games per player looked at */
  perPlayer?: number;
  /** individual mode: teammates found to fill the roles not given */
  filled?: number;
}

const MIN_SHARED = 3; // an ally must appear at least this often to count as a teammate

/** Find the Ranked 5s queue id: ranked games that are neither 420 nor 440. Cached in kv once found. */
export async function discoverFivesQueue(repo: Repo, riot: RiotClient, platform: Platform, puuid: string): Promise<number | null> {
  const known = loadFivesQueue(repo);
  if (known) return known;
  const [ranked, solo, flex] = await Promise.all([
    riot.getMatchIds(platform, puuid, { type: 'ranked', count: 100 }),
    riot.getMatchIds(platform, puuid, { queue: 420, count: 100 }),
    riot.getMatchIds(platform, puuid, { queue: 440, count: 100 }),
  ]);
  const other = ranked.filter((id) => !solo.includes(id) && !flex.includes(id));
  for (const id of other.slice(0, 3)) {
    const m = repo.getCachedMatchSince(id, Number(repo.getKv('puuid_epoch') ?? 0)) ?? (await riot.getMatch(platform, id));
    if (!m) continue;
    repo.cacheMatch(m);
    const q = m.info.queueId;
    if (q !== 420 && q !== 440 && m.info.participants.length === 10) {
      saveFivesQueue(repo, q);
      return q;
    }
  }
  return null;
}

/** Highest-total assignment of up to 5 players to distinct roles (5! = 120 permutations, brute force). */
export function assignRoles(counts: Map<string, Record<string, number>>): Map<string, Role> {
  const players = [...counts.keys()].slice(0, 5);
  let best = -1;
  let bestPerm: Role[] = [];
  const permute = (arr: Role[], k: number) => {
    if (k === arr.length) {
      const score = players.reduce((n, p, i) => n + (counts.get(p)![arr[i]!] ?? 0), 0);
      if (score > best) { best = score; bestPerm = [...arr]; }
      return;
    }
    for (let i = k; i < arr.length; i++) {
      [arr[k], arr[i]] = [arr[i]!, arr[k]!];
      permute(arr, k + 1);
      [arr[k], arr[i]] = [arr[i]!, arr[k]!];
    }
  };
  permute([...ROLES], 0);
  const out = new Map<string, Role>();
  players.forEach((p, i) => out.set(p, bestPerm[i]!));
  return out;
}

/** Smoothed weighted winrate x sqrt(weighted games): played a lot (in 5s) and won a lot. */
const threat = (c: ChampStat) => banScore(c) * Math.sqrt(c.wGames || c.games);

/** A champion needs at least this many games to be a ban target (filters out 3W 0L flukes). */
export const MIN_BAN_GAMES = 5;

/**
 * Of the 10 most played champs, the 3 best winrates among those with MIN_BAN_GAMES+ games.
 * Fewer (or none) are returned when not enough champs have a real sample.
 */
export function topBans(champs: ChampStat[]): ChampStat[] {
  const top10 = [...champs].sort((a, b) => b.wGames - a.wGames || b.games - a.games || b.wins - a.wins).slice(0, 10);
  return top10
    .filter((c) => c.games >= MIN_BAN_GAMES)
    .sort((a, b) => banScore(b) - banScore(a) || b.games - a.games)
    .slice(0, 3);
}

/** Games looked at per scouted player. */
export const SCOUT_GAMES = 30;

/**
 * Match ids to scout one player from: up to `n` Ranked 5s games first; if there aren't
 * that many, the rest are filled with their most recent Flex / Solo/Duo games.
 */
export async function scoutIds(riot: RiotClient, platform: Platform, puuid: string, fivesQ: number | null, n = SCOUT_GAMES): Promise<string[]> {
  const num = (id: string) => Number(id.split('_')[1] ?? 0);
  // One list call when they have n Ranked 5s games, two otherwise. "ranked" lists Solo/Duo, Flex and 5s
  // newest first; with fewer than n 5s games the first list holds all of them, so the rest is Flex / Solo.
  const fives = fivesQ ? await riot.getMatchIds(platform, puuid, { queue: fivesQ, count: n }).catch(() => [] as string[]) : [];
  if (fives.length >= n) return fives.slice(0, n);
  const need = n - fives.length;
  const ranked = await riot.getMatchIds(platform, puuid, { type: 'ranked', count: Math.min(100, n + fives.length) }).catch(() => [] as string[]);
  const fill = ranked.filter((id) => !fives.includes(id)).sort((a, b) => num(b) - num(a)).slice(0, need);
  return [...fives, ...fill];
}

export async function scoutTeam(
  repo: Repo,
  riot: RiotClient,
  target: { puuid: string; name: string; tag: string; platform: Platform },
  opts: { games?: number; log?: (m: string) => void } = {},
): Promise<ScoutReport> {
  const N = opts.games ?? SCOUT_GAMES;
  const fivesQ = await discoverFivesQueue(repo, riot, target.platform, target.puuid).catch(() => null);
  // Ranked 5s first (it's what we're scouting for), newest Flex / Solo games fill up to N.
  const ids = await scoutIds(riot, target.platform, target.puuid, fivesQ, N);

  const matches: MatchDto[] = [];
  await Promise.all(ids.map(async (id) => {
    // Matches cached before an API key change hold other-key PUUIDs: refetch so teammates line up.
    let m = repo.getCachedMatchSince(id, Number(repo.getKv('puuid_epoch') ?? 0));
    if (!m) {
      m = await riot.getMatch(target.platform, id).catch(() => null);
      if (m) repo.cacheMatch(m);
    }
    if (m && m.info.participants.some((p) => p.puuid === target.puuid) && !m.info.participants[0]?.gameEndedInEarlySurrender) matches.push(m);
  }));
  opts.log?.(`scout ${target.name}#${target.tag}: ${matches.length} games from ${ids.length} ids`);

  // queue weights: Ranked 5s holds FIVES_WEIGHT of the total, Flex the rest (mean weight 1)
  const isFivesGame = (m: MatchDto) => fivesQ !== null && m.info.queueId === fivesQ;
  const nFives = matches.filter(isFivesGame).length;
  const nFlex = matches.length - nFives; // Flex and Solo/Duo fill-ins share the rest
  const weights = nFives && nFlex
    ? { fives: (FIVES_WEIGHT * matches.length) / nFives, flex: ((1 - FIVES_WEIGHT) * matches.length) / nFlex }
    : { fives: 1, flex: 1 };
  const wOf = (m: MatchDto) => (isFivesGame(m) ? weights.fives : weights.flex);

  // allies frequency (raw count for the threshold, weighted for ranking)
  const allyCount = new Map<string, { n: number; w: number }>();
  for (const m of matches) {
    const me = m.info.participants.find((p) => p.puuid === target.puuid)!;
    for (const p of m.info.participants) {
      if (p.teamId !== me.teamId || p.puuid === target.puuid) continue;
      const cur = allyCount.get(p.puuid) ?? { n: 0, w: 0 };
      allyCount.set(p.puuid, { n: cur.n + 1, w: cur.w + wOf(m) });
    }
  }
  const mates = [...allyCount.entries()].filter(([, v]) => v.n >= MIN_SHARED).sort((a, b) => b[1].w - a[1].w).slice(0, 4).map(([k]) => k);
  const team = [target.puuid, ...mates];

  // per-member stats from games in the sample
  const pos = new Map<string, Record<string, number>>();
  const champs = new Map<string, Map<string, ChampStat>>();
  const record = new Map<string, { games: number; wins: number; name: string; tag: string }>();
  let fullStack = 0;
  for (const m of matches) {
    const w = wOf(m);
    const present = team.filter((id) => m.info.participants.some((p) => p.puuid === id));
    if (present.length === team.length && team.length === 5) fullStack++;
    for (const p of m.info.participants) {
      if (!team.includes(p.puuid)) continue;
      const r = record.get(p.puuid) ?? { games: 0, wins: 0, name: p.riotIdGameName ?? '?', tag: p.riotIdTagline ?? '' };
      r.games++;
      if (p.win) r.wins++;
      record.set(p.puuid, r);
      const pc = pos.get(p.puuid) ?? {};
      if (p.teamPosition) pc[p.teamPosition] = (pc[p.teamPosition] ?? 0) + w;
      pos.set(p.puuid, pc);
      const cm = champs.get(p.puuid) ?? new Map<string, ChampStat>();
      const c = cm.get(p.championName) ?? { championId: p.championId, championName: p.championName, games: 0, wins: 0, wGames: 0, wWins: 0, version: m.info.gameVersion };
      c.games++;
      c.wGames += w;
      if (p.win) { c.wins++; c.wWins += w; }
      cm.set(p.championName, c);
      champs.set(p.puuid, cm);
    }
  }

  const roles = assignRoles(new Map(team.map((id) => [id, pos.get(id) ?? {}])));
  const members: MemberReport[] = team.map((id) => {
    const r = record.get(id) ?? { games: 0, wins: 0, name: id === target.puuid ? target.name : '?', tag: '' };
    const role = roles.get(id) ?? null;
    const pc = pos.get(id) ?? {};
    const total = Object.values(pc).reduce((a, b) => a + b, 0) || 1;
    const list = [...(champs.get(id)?.values() ?? [])];
    return {
      puuid: id,
      name: id === target.puuid ? target.name : r.name,
      tag: id === target.puuid ? target.tag : r.tag,
      role,
      roleShare: role ? (pc[role] ?? 0) / total : 0,
      games: r.games,
      wins: r.wins,
      mostPlayed: [...list].sort((a, b) => b.games - a.games || b.wGames - a.wGames).slice(0, 10), // display: raw counts
      bans: topBans(list),
      isTarget: id === target.puuid,
    };
  });
  members.sort((a, b) => (a.role ? ROLES.indexOf(a.role) : 9) - (b.role ? ROLES.indexOf(b.role) : 9));

  // team-wide priority bans: each member's ban picks, ranked by threat, distinct champions
  const seen = new Set<string>();
  const priorityBans = members
    .flatMap((m) => m.bans.map((b) => ({ ...b, owner: m.name })))
    .sort((a, b) => threat(b) - threat(a))
    .filter((b) => (seen.has(b.championName) ? false : (seen.add(b.championName), true)))
    .slice(0, 5);

  return markOtps({
    target,
    members,
    priorityBans,
    sample: matches.length,
    queues: { flex: matches.filter((m) => m.info.queueId === 440).length, fives: nFives, solo: matches.filter((m) => m.info.queueId === 420).length },
    weights,
    fivesQueueId: fivesQ,
    premadeShare: matches.length ? fullStack / matches.length : 0,
  });
}

/** Games per player when several players are scouted individually. */
export const INDIVIDUAL_GAMES = SCOUT_GAMES;
/**
 * New (uncached) games one multi-player scout may fetch. With up to 5 account + 10 match-list calls
 * a cold scout stays under ~45 requests, so two back to back fit the personal key's 100 per 2 min.
 */
export const MAX_NEW_MATCHES = 30;

/**
 * Scout 2–5 players given by hand (e.g. the five you're facing, premade or not): each one
 * from their own last ranked games (Solo/Duo, Flex, 5s; Ranked 5s weighted FIVES_WEIGHT),
 * roles fitted across them, plus how often they actually queue together.
 */
export async function scoutPlayers(
  repo: Repo,
  riot: RiotClient,
  players: { puuid: string; name: string; tag: string; platform: Platform }[],
  opts: { games?: number; log?: (m: string) => void } = {},
): Promise<ScoutReport> {
  const N = opts.games ?? INDIVIDUAL_GAMES;
  const first = players[0]!;
  const fivesQ = await discoverFivesQueue(repo, riot, first.platform, first.puuid).catch(() => null);
  const epoch = Number(repo.getKv('puuid_epoch') ?? 0);
  const load = async (platform: Platform, id: string) => {
    let m = repo.getCachedMatchSince(id, epoch);
    if (!m) {
      m = await riot.getMatch(platform, id).catch(() => null);
      if (m) repo.cacheMatch(m);
    }
    return m;
  };

  const all = new Map<string, MatchDto>();
  const given = new Set(players.map((p) => p.puuid));
  // Same sample as a single scout (Ranked 5s first, newest Flex / Solo fill the rest), but games
  // not cached yet are capped at MAX_NEW_MATCHES per scout, taken round-robin (each player's newest
  // first) so every player gets a fair share. Cached games are free and always used.
  const lists = await Promise.all(players.map((pl) => scoutIds(riot, pl.platform, pl.puuid, fivesQ, N)));
  const pick: { platform: Platform; id: string }[] = [];
  const picked = new Set<string>();
  let fresh = 0;
  for (let i = 0; i < N; i++) {
    players.forEach((pl, k) => {
      const id = lists[k]![i];
      if (!id || picked.has(id)) return;
      const cached = repo.getCachedMatchSince(id, epoch) !== null;
      if (!cached && fresh >= MAX_NEW_MATCHES) return;
      if (!cached) fresh++;
      picked.add(id);
      pick.push({ platform: pl.platform, id });
    });
  }
  const ms = await Promise.all(pick.map((p) => load(p.platform, p.id)));
  for (const m of ms) if (m && !m.info.participants[0]?.gameEndedInEarlySurrender) all.set(m.metadata.matchId, m);
  opts.log?.(`scout ${players.length} players: ${all.size} games, ${fresh} fetched`);
  const isFives = (m: MatchDto) => fivesQ !== null && m.info.queueId === fivesQ;
  const isTeamQueue = (m: MatchDto) => m.info.queueId === 440 || isFives(m);

  // Fewer than 5 given: fill the team with whoever queues Flex / 5s with them most.
  const filled: { puuid: string; name: string; tag: string }[] = [];
  if (players.length < 5) {
    const allies = new Map<string, { n: number; w: number; name: string; tag: string }>();
    for (const m of all.values()) {
      if (!isTeamQueue(m)) continue;
      const teams = new Set(m.info.participants.filter((p) => given.has(p.puuid)).map((p) => p.teamId));
      for (const p of m.info.participants) {
        if (given.has(p.puuid) || !teams.has(p.teamId)) continue;
        const a = allies.get(p.puuid) ?? { n: 0, w: 0, name: p.riotIdGameName ?? '?', tag: p.riotIdTagline ?? '' };
        a.n++;
        a.w += isFives(m) ? 2 : 1;
        allies.set(p.puuid, a);
      }
    }
    for (const [puuid, a] of [...allies].filter(([, a]) => a.n >= MIN_SHARED).sort((x, y) => y[1].w - x[1].w).slice(0, 5 - players.length)) {
      filled.push({ puuid, name: a.name, tag: a.tag });
    }
  }
  const team = [...players.map((p) => ({ puuid: p.puuid, name: p.name, tag: p.tag, given: true })), ...filled.map((f) => ({ ...f, given: false }))];

  // games per member: given players from all their games; found teammates from games with a given player
  const gamesOf = (puuid: string, isGiven: boolean) => [...all.values()].filter((m) => {
    const me = m.info.participants.find((p) => p.puuid === puuid);
    if (!me) return false;
    return isGiven || m.info.participants.some((p) => given.has(p.puuid) && p.teamId === me.teamId);
  });

  const pos = new Map<string, Record<string, number>>();
  const members: MemberReport[] = [];
  let nFives = 0, nFlex = 0, nSolo = 0;
  for (const pl of team) {
    const ms = gamesOf(pl.puuid, pl.given);
    // per player: Ranked 5s holds FIVES_WEIGHT of the weight when both kinds are present
    const f = ms.filter(isFives).length;
    const o = ms.length - f;
    const wF = f && o ? (FIVES_WEIGHT * ms.length) / f : 1;
    const wO = f && o ? ((1 - FIVES_WEIGHT) * ms.length) / o : 1;
    const pc: Record<string, number> = {};
    const cm = new Map<string, ChampStat>();
    let wins = 0;
    for (const m of ms) {
      const p = m.info.participants.find((x) => x.puuid === pl.puuid)!;
      const w = isFives(m) ? wF : wO;
      if (p.win) wins++;
      if (p.teamPosition) pc[p.teamPosition] = (pc[p.teamPosition] ?? 0) + w;
      const c = cm.get(p.championName) ?? { championId: p.championId, championName: p.championName, games: 0, wins: 0, wGames: 0, wWins: 0, version: m.info.gameVersion };
      c.games++;
      c.wGames += w;
      if (p.win) { c.wins++; c.wWins += w; }
      cm.set(p.championName, c);
    }
    pos.set(pl.puuid, pc);
    const list = [...cm.values()];
    members.push({
      puuid: pl.puuid, name: pl.name, tag: pl.tag, role: null, roleShare: 0,
      games: ms.length, wins,
      mostPlayed: [...list].sort((a, b) => b.games - a.games || b.wGames - a.wGames).slice(0, 10),
      bans: topBans(list),
      isTarget: pl.given && players.length < 5, // badge who was entered when others were filled in
    });
  }
  for (const m of all.values()) {
    if (isFives(m)) nFives++;
    else if (m.info.queueId === 440) nFlex++;
    else nSolo++;
  }

  const roles = assignRoles(pos);
  for (const m of members) {
    m.role = roles.get(m.puuid) ?? null;
    const pc = pos.get(m.puuid) ?? {};
    const total = Object.values(pc).reduce((a, b) => a + b, 0) || 1;
    m.roleShare = m.role ? (pc[m.role] ?? 0) / total : 0;
  }
  members.sort((a, b) => (a.role ? ROLES.indexOf(a.role) : 9) - (b.role ? ROLES.indexOf(b.role) : 9));

  // how often the given players actually queue together: 2+ of them on one team / all of them
  let together = 0, full = 0;
  for (const m of all.values()) {
    const byTeam = new Map<number, number>();
    for (const p of m.info.participants) if (given.has(p.puuid)) byTeam.set(p.teamId, (byTeam.get(p.teamId) ?? 0) + 1);
    const most = Math.max(0, ...byTeam.values());
    if (most >= 2) together++;
    if (most === players.length) full++;
  }

  const seen = new Set<string>();
  const priorityBans = members
    .flatMap((m) => m.bans.map((b) => ({ ...b, owner: m.name })))
    .sort((a, b) => threat(b) - threat(a))
    .filter((b) => (seen.has(b.championName) ? false : (seen.add(b.championName), true)))
    .slice(0, 5);

  opts.log?.(`scout ${players.map((p) => `${p.name}#${p.tag}`).join(', ')}: ${all.size} games, ${together} together`);
  return markOtps({
    target: first,
    members,
    priorityBans,
    sample: all.size,
    filled: filled.length,
    queues: { flex: nFlex, fives: nFives, solo: nSolo },
    weights: { fives: 1, flex: 1 },
    fivesQueueId: fivesQ,
    premadeShare: all.size ? full / all.size : 0,
    mode: 'individual',
    together,
    perPlayer: N,
  });
}

/** A player counts as a one-trick when one champion is OTP_SHARE+ of their games (min OTP_MIN_GAMES). */
export const OTP_SHARE = 0.6;
export const OTP_MIN_GAMES = 8;

/**
 * Flag one-tricks and put their champion at the front of the priority bans: banning a
 * one-trick's champion takes away most of what they play, whatever its winrate.
 */
export function markOtps(r: ScoutReport): ScoutReport {
  const otpBans: (ChampStat & { owner: string; otp?: boolean })[] = [];
  for (const m of r.members) {
    const top = [...m.mostPlayed].sort((a, b) => b.games - a.games)[0];
    m.otp = top && m.games >= OTP_MIN_GAMES && top.games / m.games >= OTP_SHARE ? { championName: top.championName, share: top.games / m.games } : null;
    if (m.otp && top) otpBans.push({ ...top, owner: m.name, otp: true });
  }
  if (!otpBans.length) return r;
  otpBans.sort((a, b) => b.games - a.games);
  const rest = r.priorityBans.filter((b) => !otpBans.some((o) => o.championName === b.championName));
  return { ...r, priorityBans: [...otpBans, ...rest].slice(0, 5) };
}
