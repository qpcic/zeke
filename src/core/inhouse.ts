import { absoluteLp, formatRank, type Rank } from './rank.ts';

/**
 * In-house 5v5s (owner console, `$admin 5v5`). People are put on a list once with their main
 * role; for a night they go into the pool, and `generate` splits ten of them into two teams.
 *  - tryhard: as many people on their main role as possible, then the closest average rank
 *  - offrole: as few people on their main role as possible (ideally none), then closest rank
 *  - random:  random teams and roles
 * Rank is Solo/Duo. Within near-equal options the pick is random, so a reroll gives new teams.
 */

export const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABEL: Record<Role, string> = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'Bot', UTILITY: 'Support' };
export const MODES = ['tryhard', 'random', 'offrole'] as const;
export type Mode = (typeof MODES)[number];

const ROLE_WORDS: Record<string, Role> = {
  top: 'TOP', toplane: 'TOP',
  jungle: 'JUNGLE', jg: 'JUNGLE', jng: 'JUNGLE', jung: 'JUNGLE', jungler: 'JUNGLE',
  mid: 'MIDDLE', middle: 'MIDDLE', midlane: 'MIDDLE',
  bot: 'BOTTOM', bottom: 'BOTTOM', adc: 'BOTTOM', ad: 'BOTTOM', carry: 'BOTTOM', marksman: 'BOTTOM',
  support: 'UTILITY', supp: 'UTILITY', sup: 'UTILITY', utility: 'UTILITY',
};
export const parseRole = (w: string | undefined): Role | null => (w ? ROLE_WORDS[w.toLowerCase().replace(/[^a-z]/g, '')] ?? null : null);
export const parseMode = (w: string | undefined): Mode | null => {
  const s = (w ?? '').toLowerCase();
  return s === 'tryhard' || s === 'th' || s === 'main' || s === 'mains' ? 'tryhard'
    : s === 'random' || s === 'rng' || s === 'rand' ? 'random'
    : s === 'offrole' || s === 'off' || s === 'offroles' || s === 'chaos' ? 'offrole' : null;
};

export interface InhousePlayer {
  puuid: string;
  name: string;
  tag: string;
  main: Role;
  /** Solo/Duo; null = unranked */
  rank: Rank | null;
  /** in-house rating */
  rating: number;
  /** forced: must play one of these (empty/undefined = any role) */
  allowed?: Role[];
}
export interface Seat { player: InhousePlayer; role: Role }
export interface Matchup {
  mode: Mode;
  blue: Seat[]; // in role order
  red: Seat[];
  blueAvg: number; // absolute LP
  redAvg: number;
  onMain: number;
  bench: InhousePlayer[];
}

/** Gold IV 0 LP: what an unranked player counts as when nobody in the pool is ranked. */
const UNRANKED_DEFAULT = 1200;
/** Splits whose average-rank gap is this close to the best one count as equally good. */
const TOLERANCE_LP = 30;

const PERMS: number[][] = (() => {
  const out: number[][] = [];
  const go = (rest: number[], acc: number[]) => {
    if (!rest.length) return void out.push(acc);
    rest.forEach((x, i) => go([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, x]));
  };
  go([0, 1, 2, 3, 4], []);
  return out;
})();

/** Every way to put five of ten people (by index) on the team with person 0: 126 splits. */
const SPLITS: number[][] = (() => {
  const out: number[][] = [];
  for (let m = 0; m < 1 << 10; m++) {
    if (!(m & 1)) continue;
    const idx = [...Array(10).keys()].filter((i) => m & (1 << i));
    if (idx.length === 5) out.push(idx);
  }
  return out;
})();

export function rankValue(r: Rank | null): number | null {
  if (!r) return null;
  try { return absoluteLp(r); } catch { return null; }
}

export function generate(pool: InhousePlayer[], mode: Mode, rng: () => number = Math.random): Matchup {
  if (pool.length < 10) throw new Error(`Need 10 players in the pool, have ${pool.length}.`);
  const shuffled = shuffle([...pool], rng);
  const ten = shuffled.slice(0, 10);
  const bench = shuffled.slice(10);
  const ranked = ten.map((p) => rankValue(p.rank)).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const fallback = ranked.length ? ranked[Math.floor(ranked.length / 2)]! : UNRANKED_DEFAULT;
  const val = ten.map((p) => rankValue(p.rank) ?? fallback);

  // forced roles: a role assignment is only allowed if everyone gets one of theirs
  const ok = (team: number[], perm: number[]) => perm.every((r, k) => {
    const a = ten[team[k]!]!.allowed;
    return !a?.length || a.includes(ROLES[r]!);
  });
  let blueIdx: number[], redIdx: number[], blueRoles: number[], redRoles: number[];
  if (mode === 'random') {
    const splits = shuffle(SPLITS.map((a) => [a, [...Array(10).keys()].filter((i) => !a.includes(i))] as const), rng);
    const fit = splits.map(([a, b]) => ({ a, b, pa: PERMS.filter((p) => ok(a, p)), pb: PERMS.filter((p) => ok(b, p)) })).filter((x) => x.pa.length && x.pb.length);
    if (!fit.length) throw new ForcedRolesError();
    const o = fit[0]!;
    const swap = rng() < 0.5;
    blueIdx = swap ? o.b : o.a; redIdx = swap ? o.a : o.b;
    const pa = o.pa[Math.floor(rng() * o.pa.length)]!, pb = o.pb[Math.floor(rng() * o.pb.length)]!;
    blueRoles = swap ? pb : pa; redRoles = swap ? pa : pb;
  } else {
    // per team: the role assignments with the most (tryhard) / fewest (offrole) people on their main
    const better = (a: number, b: number) => (mode === 'tryhard' ? a > b : a < b);
    const bestFor = (team: number[]) => {
      let best = -1, perms: number[][] = [];
      for (const perm of PERMS) {
        if (!ok(team, perm)) continue;
        const n = perm.reduce((s, r, k) => s + (ten[team[k]!]!.main === ROLES[r] ? 1 : 0), 0);
        if (best < 0 || better(n, best)) { best = n; perms = [perm]; } else if (n === best) perms.push(perm);
      }
      return { n: best, perms };
    };
    const options = SPLITS.map((a) => {
      const b = [...Array(10).keys()].filter((i) => !a.includes(i));
      const A = bestFor(a), B = bestFor(b);
      const avg = (t: number[]) => t.reduce((s, i) => s + val[i]!, 0) / 5;
      return { a, b, A, B, n: A.n + B.n, diff: Math.abs(avg(a) - avg(b)) };
    }).filter((o) => o.A.perms.length && o.B.perms.length);
    if (!options.length) throw new ForcedRolesError();
    const target = mode === 'tryhard' ? Math.max(...options.map((o) => o.n)) : Math.min(...options.map((o) => o.n));
    const fit = options.filter((o) => o.n === target);
    const minDiff = Math.min(...fit.map((o) => o.diff));
    const close = fit.filter((o) => o.diff <= minDiff + TOLERANCE_LP);
    const o = close[Math.floor(rng() * close.length)]!;
    const swap = rng() < 0.5;
    blueIdx = swap ? o.b : o.a; redIdx = swap ? o.a : o.b;
    const pa = o.A.perms[Math.floor(rng() * o.A.perms.length)]!, pb = o.B.perms[Math.floor(rng() * o.B.perms.length)]!;
    blueRoles = swap ? pb : pa; redRoles = swap ? pa : pb;
  }
  const seats = (idx: number[], roles: number[]): Seat[] =>
    idx.map((i, k) => ({ player: ten[i]!, role: ROLES[roles[k]!]! })).sort((x, y) => ROLES.indexOf(x.role) - ROLES.indexOf(y.role));
  const blue = seats(blueIdx, blueRoles), red = seats(redIdx, redRoles);
  const avg = (idx: number[]) => idx.reduce((s, i) => s + val[i]!, 0) / 5;
  return {
    mode, blue, red, blueAvg: avg(blueIdx), redAvg: avg(redIdx),
    onMain: [...blue, ...red].filter((s) => s.player.main === s.role).length,
    bench,
  };
}

export class ForcedRolesError extends Error {
  constructor() { super("The forced roles can't all be met: two teams of five need one of each role. Loosen some in `$admin 5v5 force`."); }
}

function shuffle<T>(a: T[], rng: () => number): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ---------- in-house rating ----------

export const START_RATING = 1000;
/** Even teams: ±K/2 (25). Upsets move more, expected wins less (Elo on the team averages). */
export const RATING_K = 50;
/** Played your main role: half the change, win or lose (off-role is the harder job). */
export const MAIN_ROLE_FACTOR = 0.5;

export interface RatingChange { puuid: string; delta: number; won: boolean }

export function ratingChanges(blue: { puuid: string; rating: number; onMain: boolean }[], red: { puuid: string; rating: number; onMain: boolean }[], winner: 'blue' | 'red'): RatingChange[] {
  const avg = (t: { rating: number }[]) => t.reduce((s, p) => s + p.rating, 0) / t.length;
  const [w, l] = winner === 'blue' ? [blue, red] : [red, blue];
  const expected = 1 / (1 + 10 ** ((avg(l) - avg(w)) / 400));
  const base = Math.max(1, Math.round(RATING_K * (1 - expected)));
  const amount = (onMain: boolean) => Math.max(1, Math.round(base * (onMain ? MAIN_ROLE_FACTOR : 1)));
  return [
    ...w.map((p) => ({ puuid: p.puuid, delta: amount(p.onMain), won: true })),
    ...l.map((p) => ({ puuid: p.puuid, delta: -amount(p.onMain), won: false })),
  ];
}

export const rankText = (r: Rank | null) => formatRank(r);
