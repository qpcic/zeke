import type { Repo } from '../db/repo.ts';
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
}
export interface ScoutReport {
  target: { puuid: string; name: string; tag: string; platform: Platform };
  members: MemberReport[]; // ordered by role TOP..UTILITY, unassigned last
  priorityBans: (ChampStat & { owner: string })[];
  sample: number;
  queues: { flex: number; fives: number };
  /** per-game weight actually applied ({ fives: 1, flex: 1 } when only one queue is present) */
  weights: { fives: number; flex: number };
  fivesQueueId: number | null;
  premadeShare: number; // fraction of games where the 4 detected teammates were all present
}

const KV_FIVES = 'ranked5s_queue_id';
const MIN_SHARED = 3; // an ally must appear at least this often to count as a teammate

/** Find the Ranked 5s queue id: ranked games that are neither 420 nor 440. Cached in kv once found. */
export async function discoverFivesQueue(repo: Repo, riot: RiotClient, platform: Platform, puuid: string): Promise<number | null> {
  const known = repo.getKv(KV_FIVES);
  if (known) return Number(known);
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
      repo.setKv(KV_FIVES, String(q));
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

export async function scoutTeam(
  repo: Repo,
  riot: RiotClient,
  target: { puuid: string; name: string; tag: string; platform: Platform },
  opts: { games?: number; log?: (m: string) => void } = {},
): Promise<ScoutReport> {
  const N = opts.games ?? 50;
  const fivesQ = await discoverFivesQueue(repo, riot, target.platform, target.puuid).catch(() => null);
  const [flexIds, fivesIds] = await Promise.all([
    riot.getMatchIds(target.platform, target.puuid, { queue: 440, count: N }),
    fivesQ ? riot.getMatchIds(target.platform, target.puuid, { queue: fivesQ, count: N }) : Promise.resolve([] as string[]),
  ]);
  // Ranked 5s first (it's what we're scouting for), newest Flex games fill up to N.
  const num = (id: string) => Number(id.split('_')[1] ?? 0);
  const fives = [...fivesIds].sort((a, b) => num(b) - num(a)).slice(0, N);
  const flex = flexIds.filter((id) => !fives.includes(id)).sort((a, b) => num(b) - num(a)).slice(0, N - fives.length);
  const ids = [...fives, ...flex];

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
  opts.log?.(`scout ${target.name}#${target.tag}: ${matches.length} games (${flexIds.length} flex ids, ${fivesIds.length} 5s ids)`);

  // queue weights: Ranked 5s holds FIVES_WEIGHT of the total, Flex the rest (mean weight 1)
  const nFives = matches.filter((m) => m.info.queueId !== 440).length;
  const nFlex = matches.length - nFives;
  const weights = nFives && nFlex
    ? { fives: (FIVES_WEIGHT * matches.length) / nFives, flex: ((1 - FIVES_WEIGHT) * matches.length) / nFlex }
    : { fives: 1, flex: 1 };
  const wOf = (m: MatchDto) => (m.info.queueId === 440 ? weights.flex : weights.fives);

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

  return {
    target,
    members,
    priorityBans,
    sample: matches.length,
    queues: { flex: nFlex, fives: nFives },
    weights,
    fivesQueueId: fivesQ,
    premadeShare: matches.length ? fullStack / matches.length : 0,
  };
}
