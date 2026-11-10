import type { MatchDto, ParticipantDto } from '../riot/types.ts';

/**
 * Simple op.gg-style performance score (0-10) from KDA, kill participation,
 * damage/gold/vision share. MVP = best on the winning team, ACE = best on the losing team.
 */
export interface Performance { score: number; rank: number; badge: 'MVP' | 'ACE' | null }

export function performances(m: MatchDto): Map<string, Performance> {
  const ps = m.info.participants;
  const team = (p: ParticipantDto) => ps.filter((x) => x.teamId === p.teamId);
  const sum = (xs: ParticipantDto[], f: (p: ParticipantDto) => number) => xs.reduce((n, p) => n + f(p), 0) || 1;

  const raw = ps.map((p) => {
    const t = team(p);
    const kda = Math.min((p.kills + p.assists) / Math.max(1, p.deaths), 10) / 10;
    const kp = (p.kills + p.assists) / sum(t, (x) => x.kills);
    const dmg = p.totalDamageDealtToChampions / sum(t, (x) => x.totalDamageDealtToChampions);
    const gold = p.goldEarned / sum(t, (x) => x.goldEarned);
    const vis = p.visionScore / sum(t, (x) => x.visionScore);
    // Shares are normalised against a "carry-level" share (35% dmg, 35% vision, 30% gold) and capped.
    const s = 0.3 * kda + 0.25 * Math.min(kp, 1) + 0.25 * Math.min(dmg / 0.35, 1) + 0.1 * Math.min(vis / 0.35, 1) + 0.1 * Math.min(gold / 0.3, 1);
    return { p, s: Math.round(s * 100) / 10 };
  });
  const ranked = [...raw].sort((a, b) => b.s - a.s);
  const out = new Map<string, Performance>();
  ranked.forEach(({ p, s }, i) => out.set(p.puuid, { score: s, rank: i + 1, badge: null }));
  for (const won of [true, false]) {
    const best = ranked.find((x) => x.p.win === won);
    if (best && !m.info.participants[0]?.gameEndedInEarlySurrender) out.get(best.p.puuid)!.badge = won ? 'MVP' : 'ACE';
  }
  return out;
}
