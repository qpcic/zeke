import type { AssetSource, StaticData } from '../../assets/ddragon.ts';
import { C, createCanvas, decode, ensureFonts, fit, font, icon, pill, rounded } from './canvas.ts';

/** /roles card: winrate, KDA and best champions per position over recent ranked games. */

export interface RoleChamp { championId: number; championName: string; wins: number; games: number }
export interface RoleRow {
  role: 'TOP' | 'JUNGLE' | 'MIDDLE' | 'BOTTOM' | 'UTILITY';
  games: number;
  wins: number;
  k: number; d: number; a: number; // averages
  csPerMin: number;
  kp: number | null; // 0..1
  champs: RoleChamp[]; // most played first, up to 3
}
export interface RolesCard {
  player: string;
  tag: string;
  queueLabel: string;
  sample: number;
  version: string;
  rows: RoleRow[]; // always the 5 roles in lane order
  best: RoleRow['role'] | null;
  worst: RoleRow['role'] | null;
}

export const ROLE_ORDER: RoleRow['role'][] = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const LABEL: Record<RoleRow['role'], string> = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'Bot', UTILITY: 'Support' };

const W = 1040, PAD = 24, HEAD = 108, ROW = 88, GAP = 10;

export async function renderRoles(d: RolesCard, assets: AssetSource | null): Promise<Buffer> {
  ensureFonts();
  const sd: StaticData | null = assets ? await assets.staticData(d.version).catch(() => null) : null;
  const imgs = new Map<number, Awaited<ReturnType<typeof decode>>>();
  if (assets && sd) {
    const ids = [...new Set(d.rows.flatMap((r) => r.champs.map((c) => c.championId)))];
    await Promise.all(ids.map(async (id) => imgs.set(id, await decode(await assets.image(assets.championUrl(sd, id, ''))).catch(() => null))));
  }

  const H = HEAD + ROLE_ORDER.length * (ROW + GAP) + PAD - GAP + 8;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = C.text;
  ctx.font = font(700, 26);
  ctx.fillText(d.player, PAD, 44);
  const nameW = ctx.measureText(d.player).width;
  ctx.fillStyle = C.faint;
  ctx.font = font(400, 20);
  ctx.fillText(`#${d.tag}`, PAD + nameW + 6, 44);
  ctx.fillStyle = C.sub;
  ctx.font = font(400, 16);
  ctx.fillText(`Roles · last ${d.sample} ${d.queueLabel} game${d.sample === 1 ? '' : 's'}`, PAD, 70);

  // column headers
  const COL = { role: PAD + 18, bar: PAD + 150, wr: PAD + 360, kda: PAD + 470, cs: PAD + 610, champs: PAD + 700 };
  ctx.fillStyle = C.faint;
  ctx.font = font(600, 12);
  for (const [k, t] of [['bar', 'GAMES'], ['wr', 'WINRATE'], ['kda', 'KDA'], ['cs', 'CS/MIN'], ['champs', 'TOP CHAMPIONS']] as const) ctx.fillText(t, COL[k], HEAD - 8);

  const maxGames = Math.max(1, ...d.rows.map((r) => r.games));
  d.rows.forEach((r, i) => {
    const y = HEAD + i * (ROW + GAP);
    const empty = r.games === 0;
    ctx.fillStyle = r.role === d.best ? 'rgba(63,185,80,0.10)' : r.role === d.worst ? 'rgba(248,81,73,0.09)' : C.panel;
    rounded(ctx, PAD, y, W - 2 * PAD, ROW, 10); ctx.fill();
    ctx.globalAlpha = empty ? 0.45 : 1;
    const mid = y + ROW / 2;

    ctx.fillStyle = C.text;
    ctx.font = font(700, 20);
    ctx.fillText(LABEL[r.role], COL.role, mid + (r.role === d.best || r.role === d.worst ? -2 : 7));
    if (r.role === d.best) pill(ctx, 'BEST', COL.role, mid + 8, C.win, '#0d1117');
    if (r.role === d.worst) pill(ctx, 'WORST', COL.role, mid + 8, C.loss, '#0d1117');

    // games: bar + count
    const bw = 170;
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    rounded(ctx, COL.bar, mid - 5, bw, 10, 5); ctx.fill();
    if (r.games) {
      ctx.fillStyle = '#8b97ff';
      rounded(ctx, COL.bar, mid - 5, Math.max(10, (r.games / maxGames) * bw), 10, 5); ctx.fill();
    }
    ctx.fillStyle = C.sub;
    ctx.font = font(600, 14);
    ctx.fillText(empty ? 'no games' : `${r.games} game${r.games === 1 ? '' : 's'} · ${Math.round((r.games / Math.max(1, d.sample)) * 100)}%`, COL.bar, mid + 26);

    if (!empty) {
      const wr = r.wins / r.games;
      ctx.font = font(700, 22);
      ctx.fillStyle = wr >= 0.5 ? C.win : C.loss;
      ctx.fillText(`${Math.round(wr * 100)}%`, COL.wr, mid + 4);
      ctx.fillStyle = C.sub;
      ctx.font = font(400, 13);
      ctx.fillText(`${r.wins}W ${r.games - r.wins}L`, COL.wr, mid + 24);

      const kda = (r.k + r.a) / Math.max(1, r.d);
      ctx.font = font(700, 20);
      ctx.fillStyle = kda >= 4 ? C.gold : kda >= 3 ? '#7fb2ff' : C.text;
      ctx.fillText(`${kda.toFixed(2)}`, COL.kda, mid + 4);
      ctx.fillStyle = C.sub;
      ctx.font = font(400, 13);
      ctx.fillText(`${r.k.toFixed(1)} / ${r.d.toFixed(1)} / ${r.a.toFixed(1)}`, COL.kda, mid + 24);

      ctx.fillStyle = C.text;
      ctx.font = font(700, 20);
      ctx.fillText(r.role === 'UTILITY' ? '—' : r.csPerMin.toFixed(1), COL.cs, mid + 4);
      if (r.kp !== null) {
        ctx.fillStyle = C.sub;
        ctx.font = font(400, 13);
        ctx.fillText(`${Math.round(r.kp * 100)}% KP`, COL.cs, mid + 24);
      }

      // top champions: icon + W/L
      r.champs.slice(0, 3).forEach((c, k) => {
        const x = COL.champs + k * 100;
        icon(ctx, imgs.get(c.championId) ?? null, x, mid - 26, 52, 8, c.championName);
        ctx.font = font(700, 13);
        ctx.fillStyle = c.wins / c.games >= 0.5 ? C.win : C.loss;
        ctx.fillText(`${Math.round((c.wins / c.games) * 100)}%`, x + 58, mid - 4);
        ctx.fillStyle = C.sub;
        ctx.font = font(400, 12);
        ctx.fillText(fit(ctx, `${c.games}g`, 36), x + 58, mid + 14);
      });
    }
    ctx.globalAlpha = 1;
  });
  return canvas.toBuffer('image/png');
}
