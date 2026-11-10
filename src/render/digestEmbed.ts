import type { Digest } from '../core/digest.ts';
import { formatRank } from '../core/rank.ts';
import { COLORS, type Embed } from './embed.ts';
import { cell, signed } from './format.ts';

const QUEUE_SHORT: Record<string, string> = { RANKED_SOLO_5x5: 'Solo', RANKED_FLEX_SR: 'Flex' };

export function buildDigestEmbed(d: Digest): Embed {
  const title = d.kind === 'daily' ? `Daily recap · ${d.period.label}` : d.kind === 'weekly' ? `Weekly recap · ${d.period.label}` : `Recap · ${d.period.label}`;
  const active = d.players.filter((p) => p.games || p.lpNet);

  if (!active.length) {
    return { title, color: COLORS.digest, description: 'No ranked games played by tracked players. 💤', timestamp: new Date(d.period.to).toISOString() };
  }

  const t = d.totals;
  const wr = t.games ? Math.round((t.wins / t.games) * 100) : 0;
  const description = `**${t.games}** games · ${t.wins}W ${t.losses}L (${wr}%) · **${signed(t.lpNet)} LP** net across ${t.activePlayers} player${t.activePlayers === 1 ? '' : 's'}`;

  // Table: name | games | W-L | LP. Kept narrow (~34 cols) so it doesn't wrap on mobile.
  const header = `${cell('Player', 14)} ${cell('G', 3, 'right')} ${cell('W-L', 5, 'right')} ${cell('LP', 6, 'right')}`;
  const lines = active.map((p) =>
    `${cell(p.player.game_name, 14)} ${cell(String(p.games), 3, 'right')} ${cell(`${p.wins}-${p.losses}`, 5, 'right')} ${cell(signed(p.lpNet), 6, 'right')}`,
  );
  // Split the table across fields if it outgrows 1024 chars.
  const fields: NonNullable<Embed['fields']> = [];
  let chunk: string[] = [header];
  const flush = () => {
    fields.push({ name: fields.length ? '​' : 'Leaderboard', value: '```\n' + chunk.join('\n') + '\n```' });
    chunk = [];
  };
  for (const l of lines) {
    if ((chunk.join('\n').length + l.length + 10) > 1000) flush();
    chunk.push(l);
  }
  if (chunk.length) flush();

  const top = active[0]!;
  const bottom = active[active.length - 1]!;
  if (top.lpNet > 0) fields.push({ name: '📈 Top climber', value: `**${top.player.game_name}** ${signed(top.lpNet)} LP`, inline: true });
  if (bottom.lpNet < 0 && bottom !== top) fields.push({ name: '📉 Biggest drop', value: `**${bottom.player.game_name}** ${signed(bottom.lpNet)} LP`, inline: true });
  const grinder = [...active].sort((a, b) => b.games - a.games)[0]!;
  if (grinder.games > 0) fields.push({ name: '🎮 Most games', value: `**${grinder.player.game_name}** ${grinder.games}`, inline: true });

  // Current ranks for everyone who played.
  const rankLines = active.map((p) => {
    const rs = p.ranks.filter((r) => QUEUE_SHORT[r.queue_type]).map((r) => `${QUEUE_SHORT[r.queue_type]}: ${formatRank(r)}`);
    return `**${p.player.game_name}** — ${rs.join(' · ') || 'Unranked'}`;
  });
  const ranks = rankLines.join('\n');
  fields.push({ name: 'Current ranks', value: ranks.length > 1024 ? ranks.slice(0, 1020) + '…' : ranks });

  return { title, description, color: COLORS.digest, fields: fields.slice(0, 25), timestamp: new Date(d.period.to).toISOString() };
}

export function buildAdjustmentEmbed(name: string, queueType: string, delta: number, before: string, after: string): Embed {
  return {
    title: `${name} · ${signed(delta)} LP without a game`,
    description: `${QUEUE_SHORT[queueType] ?? queueType}: ${before} → ${after}\nLikely a dodge, decay or leaver penalty.`,
    color: delta < 0 ? COLORS.loss : COLORS.info,
  };
}
