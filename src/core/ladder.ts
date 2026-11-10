import { absoluteLp, isApex, TIERS } from './rank.ts';

/**
 * Approximate Solo/Duo distribution (share of ranked players per tier), from a public
 * census published Aug 2026 (nerfplz.com). Riot publishes no official numbers and the
 * ladder shifts daily, so percentiles below Master are estimates.
 */
const TIER_SHARE: Record<string, number> = {
  IRON: 3.77, BRONZE: 16.69, SILVER: 21.84, GOLD: 23.95, PLATINUM: 17.66, EMERALD: 11.74, DIAMOND: 3.63, APEX: 0.72,
};

/** "Top X%" estimate: tier share above you + linear position inside your tier by LP. */
export function approxTopPercent(r: { tier: string; division: string; lp: number }): number {
  if (isApex(r.tier)) return TIER_SHARE.APEX!;
  const order = TIERS.slice(0, 7); // IRON..DIAMOND
  const idx = order.indexOf(r.tier as (typeof order)[number]);
  if (idx < 0) return 100;
  let above = TIER_SHARE.APEX!;
  for (let i = order.length - 1; i > idx; i--) above += TIER_SHARE[order[i]!]!;
  const withinTier = (absoluteLp(r) - idx * 400) / 400; // 0 at IV 0 LP, ~1 at I 99 LP
  return above + TIER_SHARE[r.tier]! * (1 - Math.min(1, Math.max(0, withinTier)));
}

export const formatTopPercent = (p: number) => (p < 1 ? p.toFixed(2) : p < 10 ? p.toFixed(1) : Math.round(p).toString());
