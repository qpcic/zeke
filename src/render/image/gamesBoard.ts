import type { AssetSource, StaticData } from '../../assets/ddragon.ts';
import { championName } from '../../assets/ddragon.ts';
import { C, createCanvas, decode, ensureFonts, fit, font, icon, rounded, type Image } from './canvas.ts';

/** "Most games played" leaderboard: one row per account, a bar per games played (all ranked queues). */

export interface GamesRow {
  name: string;
  tag: string;
  games: number;
  wins: number;
  losses: number;
  /** games per queue label, e.g. { 'Solo/Duo': 8, Flex: 3 } */
  byQueue: [string, number][];
  champ: { id: number; name: string; version: string } | null;
}

export interface GamesBoardOptions {
  title: string;
  subtitle: string;
  /** tracked accounts that played nothing (not shown) */
  hiddenCount: number;
}

const W = 1040;
const PAD = 20;
const HEAD_H = 104;
const ROW_H = 64;
const FOOT_H = 40;
const MEDAL = ['#f5c542', '#c9d1d9', '#d08a52'];
const COL = { pos: PAD + 34, champ: PAD + 66, name: PAD + 122, bar: 470, barW: 380, count: W - PAD - 18 };

export async function renderGamesBoard(rows: GamesRow[], o: GamesBoardOptions, assets: AssetSource | null, sd: StaticData | null): Promise<Buffer> {
  ensureFonts();
  const champIcons: (Image | null)[] = await Promise.all(rows.map(async (r) =>
    assets && sd && r.champ ? decode(await assets.image(assets.championUrl(sd, r.champ.id, r.champ.name))).catch(() => null) : null));

  const H = HEAD_H + rows.length * ROW_H + FOOT_H;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // header (amber, to tell it apart from the LP board)
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, 'rgba(245,197,66,0.22)');
  grad.addColorStop(1, 'rgba(245,197,66,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, 84);
  ctx.fillStyle = C.text;
  ctx.font = font(700, 30);
  ctx.fillText(o.title, PAD + 8, 46);
  ctx.fillStyle = C.sub;
  ctx.font = font(400, 16);
  ctx.fillText(o.subtitle, PAD + 8, 72);

  const total = rows.reduce((n, r) => n + r.games, 0);
  const wins = rows.reduce((n, r) => n + r.wins, 0);
  ctx.textAlign = 'right';
  ctx.font = font(700, 28);
  ctx.fillStyle = C.text;
  ctx.fillText(`${total} game${total === 1 ? '' : 's'}`, W - PAD - 8, 46);
  ctx.fillStyle = C.sub;
  ctx.font = font(400, 16);
  ctx.fillText(`${wins}W ${total - wins}L · ${rows.length} player${rows.length === 1 ? '' : 's'}`, W - PAD - 8, 72);
  ctx.textAlign = 'left';

  const max = Math.max(1, ...rows.map((r) => r.games));
  rows.forEach((r, i) => {
    const y = HEAD_H + i * ROW_H;
    const mid = y + ROW_H / 2;
    ctx.fillStyle = i % 2 === 0 ? C.panel : '#1a1b1f';
    rounded(ctx, PAD, y + 4, W - 2 * PAD, ROW_H - 8, 10);
    ctx.fill();

    // position (medals for the top 3)
    ctx.textAlign = 'center';
    if (i < 3) {
      ctx.fillStyle = MEDAL[i]!;
      ctx.beginPath();
      ctx.arc(COL.pos, mid, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#16171a';
      ctx.font = font(700, 15);
      ctx.fillText(String(i + 1), COL.pos, mid + 5);
    } else {
      ctx.fillStyle = C.sub;
      ctx.font = font(700, 17);
      ctx.fillText(String(i + 1), COL.pos, mid + 6);
    }
    ctx.textAlign = 'left';

    icon(ctx, champIcons[i] ?? null, COL.champ, mid - 21, 42, 9, r.champ ? championName(sd, r.champ.id, r.champ.name) : '');

    ctx.fillStyle = C.text;
    ctx.font = font(700, 18);
    const nm = fit(ctx, r.name, 230);
    ctx.fillText(nm, COL.name, mid - 3);
    const nw = ctx.measureText(nm).width;
    ctx.fillStyle = C.faint;
    ctx.font = font(400, 14);
    ctx.fillText(fit(ctx, `#${r.tag}`, Math.max(0, 300 - nw)), COL.name + nw + 4, mid - 3);
    ctx.fillStyle = C.sub;
    ctx.font = font(400, 13);
    ctx.fillText(fit(ctx, r.byQueue.map(([q, n]) => `${q} ${n}`).join(' · '), 310), COL.name, mid + 17);

    // bar: wins (green) then losses (red), scaled to the most games
    const full = (COL.barW * r.games) / max;
    const ww = r.games ? (full * r.wins) / r.games : 0;
    ctx.fillStyle = '#2d3036';
    rounded(ctx, COL.bar, mid - 9, COL.barW, 18, 6);
    ctx.fill();
    if (ww > 0) {
      ctx.fillStyle = C.win;
      rounded(ctx, COL.bar, mid - 9, Math.max(6, ww), 18, 6);
      ctx.fill();
    }
    if (full - ww > 0) {
      ctx.fillStyle = C.loss;
      rounded(ctx, COL.bar + ww, mid - 9, Math.max(6, full - ww), 18, 6);
      ctx.fill();
    }

    ctx.textAlign = 'right';
    ctx.fillStyle = C.text;
    ctx.font = font(700, 22);
    ctx.fillText(String(r.games), COL.count, mid - 1);
    ctx.fillStyle = C.sub;
    ctx.font = font(400, 13);
    ctx.fillText(`${r.wins}W ${r.losses}L`, COL.count, mid + 17);
    ctx.textAlign = 'left';
  });

  ctx.fillStyle = C.faint;
  ctx.font = font(400, 13);
  ctx.fillText(
    [o.hiddenCount ? `${o.hiddenCount} tracked account${o.hiddenCount === 1 ? '' : 's'} without games hidden` : '', 'Ranked Solo/Duo, Flex and 5s · remakes not counted']
      .filter(Boolean).join('  ·  '),
    PAD + 8,
    H - 14,
  );
  return canvas.toBuffer('image/png');
}
