import type { Digest, PlayerDigest } from '../core/digest.ts';
import { absoluteLp, formatLpDelta, formatRank, isApex } from '../core/rank.ts';
import type { PlayerMatchRow, PlayerRow, SnapshotRow } from '../db/repo.ts';
import { PLATFORM_LABEL } from '../riot/regions.ts';
import type { MatchDto } from '../riot/types.ts';
import { championIcon, ddVersion } from './ddragon.ts';
import { COLORS, type Embed } from './embed.ts';
import { cell, signed } from './format.ts';

const QUEUE_NAME: Record<string, string> = { RANKED_SOLO_5x5: 'Solo/Duo', RANKED_FLEX_SR: 'Flex' };
const TIER_SHORT: Record<string, string> = {
  IRON: 'I', BRONZE: 'B', SILVER: 'S', GOLD: 'G', PLATINUM: 'P', EMERALD: 'E', DIAMOND: 'D', MASTER: 'M', GRANDMASTER: 'GM', CHALLENGER: 'C',
};
const DIV_NUM: Record<string, string> = { I: '1', II: '2', III: '3', IV: '4' };

/** "E2 45", "M 984" — fits a narrow table column. */
export function shortRank(s: { tier: string; division: string; lp: number } | undefined): string {
  if (!s) return '—';
  return isApex(s.tier) ? `${TIER_SHORT[s.tier]} ${s.lp}` : `${TIER_SHORT[s.tier] ?? '?'}${DIV_NUM[s.division] ?? ''} ${s.lp}`;
}

const mainRank = (ranks: SnapshotRow[] | PlayerDigest['ranks']) =>
  ranks.find((r) => r.queue_type === 'RANKED_SOLO_5x5') ?? ranks.find((r) => r.queue_type === 'RANKED_FLEX_SR');

export interface PersonalRecap {
  player: PlayerRow;
  periodLabel: string;
  stats: PlayerDigest;
  games: { row: PlayerMatchRow; match: MatchDto | null }[];
  pending: number;
}

export function buildPersonalRecapEmbed(r: PersonalRecap): Embed {
  const s = r.stats;
  const wr = s.games ? Math.round((s.wins / s.games) * 100) : 0;
  const lines: string[] = [];
  for (const { row, match } of r.games.slice(0, 15)) {
    const me = match?.info.participants.find((p) => p.puuid === r.player.puuid);
    const icon = row.remake ? '⚪' : row.win ? '🟩' : '🟥';
    const champ = me?.championName ?? '?';
    const kda = me ? `${me.kills}/${me.deaths}/${me.assists}` : '';
    const q = row.queue_id === 440 ? ' · Flex' : '';
    const lp = row.remake ? 'remake' : row.lp_delta !== null ? formatLpDelta(row.lp_delta) : row.note === 'batched' ? 'batched' : '? LP';
    lines.push(`${icon} **${champ}** ${kda} · ${lp}${q}`);
  }
  if (r.games.length > 15) lines.push(`…and ${r.games.length - 15} more`);

  const fields: NonNullable<Embed['fields']> = [];
  for (const rank of s.ranks.filter((x) => QUEUE_NAME[x.queue_type])) {
    const delta = s.lpByQueue[rank.queue_type];
    fields.push({
      name: QUEUE_NAME[rank.queue_type]!,
      value: `${formatRank(rank)}${delta ? ` (${signed(delta)})` : ''}`,
      inline: true,
    });
  }
  if (s.adjustments) fields.push({ name: 'Outside games', value: `${signed(s.adjustments)} LP (dodges / decay)`, inline: true });
  if (lines.length) fields.push({ name: 'Games', value: lines.join('\n').slice(0, 1024) });

  const lastMatch = r.games[0]?.match;
  const me = lastMatch?.info.participants.find((p) => p.puuid === r.player.puuid);
  const desc = s.games || s.remakes
    ? `**${s.games}** game${s.games === 1 ? '' : 's'} · ${s.wins}W ${s.losses}L (${wr}%) · **${signed(s.lpNet)} LP**`
    : 'No ranked games yet. 💤';

  return {
    author: { name: `${r.player.game_name}#${r.player.tag_line} · ${PLATFORM_LABEL[r.player.platform]}` },
    title: r.periodLabel,
    description: desc + (r.pending ? `\n_${r.pending} game${r.pending === 1 ? '' : 's'} waiting for LP to update_` : ''),
    color: s.lpNet > 0 ? COLORS.win : s.lpNet < 0 ? COLORS.loss : COLORS.digest,
    thumbnail: me && lastMatch ? { url: championIcon(ddVersion(lastMatch.info.gameVersion), me.championName) } : undefined,
    fields,
  };
}

/** Server leaderboard: every tracked account, including ones that didn't play. */
export function buildLeaderboardEmbed(d: Digest, title: string): Embed {
  if (!d.players.length) {
    return { title, color: COLORS.digest, description: 'No accounts tracked in this server yet. Use `/track add`.' };
  }
  const rows = [...d.players].sort((a, b) => {
    if (b.lpNet !== a.lpNet) return b.lpNet - a.lpNet;
    const ra = mainRank(a.ranks), rb = mainRank(b.ranks);
    return (rb ? absoluteLp(rb) : -1) - (ra ? absoluteLp(ra) : -1);
  });

  const header = `${cell('#', 2, 'right')} ${cell('Player', 12)} ${cell('G', 2, 'right')} ${cell('W-L', 5, 'right')} ${cell('LP', 5, 'right')} ${cell('Rank', 7, 'right')}`;
  const lines = rows.map((p, i) =>
    `${cell(String(i + 1), 2, 'right')} ${cell(p.player.game_name, 12)} ${cell(String(p.games), 2, 'right')} ${cell(`${p.wins}-${p.losses}`, 5, 'right')} ${cell(p.games || p.lpNet ? signed(p.lpNet) : '·', 5, 'right')} ${cell(shortRank(mainRank(p.ranks)), 7, 'right')}`,
  );

  const fields: NonNullable<Embed['fields']> = [];
  let chunk = [header];
  for (const l of lines) {
    if (chunk.join('\n').length + l.length > 1000) {
      fields.push({ name: fields.length ? '​' : 'Standings', value: '```\n' + chunk.join('\n') + '\n```' });
      chunk = [];
    }
    chunk.push(l);
  }
  fields.push({ name: fields.length ? '​' : 'Standings', value: '```\n' + chunk.join('\n') + '\n```' });

  const t = d.totals;
  const wr = t.games ? Math.round((t.wins / t.games) * 100) : 0;
  return {
    title,
    description: t.games
      ? `**${t.games}** games · ${t.wins}W ${t.losses}L (${wr}%) · **${signed(t.lpNet)} LP** net · ${t.activePlayers}/${d.players.length} active`
      : `No ranked games yet · ${d.players.length} tracked`,
    color: COLORS.digest,
    fields: fields.slice(0, 25),
    footer: { text: 'Solo/Duo rank shown (Flex if unranked in Solo) · LP includes dodges/decay' },
  };
}
