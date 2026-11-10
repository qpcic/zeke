export const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'] as const;
export type Tier = (typeof TIERS)[number];
const DIVISIONS = ['IV', 'III', 'II', 'I'] as const;
const APEX_BASE = 7 * 400; // IRON..DIAMOND, 4 divisions * 100 LP each

export interface Rank {
  tier: string;
  division: string;
  lp: number;
}

export const isApex = (tier: string) => tier === 'MASTER' || tier === 'GRANDMASTER' || tier === 'CHALLENGER';

/**
 * Map a rank onto one continuous LP axis so promotions/demotions diff correctly.
 * IRON IV 0 = 0, DIAMOND I 99 = 2799, MASTER+ share one ladder starting at 2800
 * (GM/Challenger are LP cutoffs inside Master, not separate ladders).
 */
export function absoluteLp(r: Rank): number {
  if (isApex(r.tier)) return APEX_BASE + r.lp;
  const t = TIERS.indexOf(r.tier as Tier);
  const d = DIVISIONS.indexOf(r.division as (typeof DIVISIONS)[number]);
  if (t < 0 || d < 0) throw new Error(`Unknown rank ${r.tier} ${r.division}`);
  return t * 400 + d * 100 + r.lp;
}

/** -1 / 0 / 1 comparing tier+division only (ignores LP). */
export function compareDivision(a: Rank, b: Rank): number {
  const key = (r: Rank) => TIERS.indexOf(r.tier as Tier) * 10 + (isApex(r.tier) ? 0 : DIVISIONS.indexOf(r.division as never));
  return Math.sign(key(a) - key(b));
}

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

export function formatRank(r: Rank | null | undefined): string {
  if (!r) return 'Unranked';
  return isApex(r.tier) ? `${titleCase(r.tier)} ${r.lp} LP` : `${titleCase(r.tier)} ${r.division} ${r.lp} LP`;
}

export function formatTierDiv(r: Rank): string {
  return isApex(r.tier) ? titleCase(r.tier) : `${titleCase(r.tier)} ${r.division}`;
}

export const formatLpDelta = (d: number | null | undefined): string =>
  d === null || d === undefined ? '? LP' : d > 0 ? `+${d} LP` : d < 0 ? `−${Math.abs(d)} LP` : '±0 LP';
