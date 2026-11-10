import type { AssetSource, StaticData } from '../../assets/ddragon.ts';
import { championName } from '../../assets/ddragon.ts';
import { isApex } from '../../core/rank.ts';
import { signed } from '../format.ts';
import { C, createCanvas, decode, ensureFonts, fit, font, icon, rounded, type Image, type SKRSContext2D } from './canvas.ts';

/** Personal daily/weekly recap PNG: header + one card per game (champ, KDA, W/L, LP). */

export interface RecapGame {
  championId: number;
  championName: string;
  gameVersion: string;
  kills: number;
  deaths: number;
  assists: number;
  result: 'win' | 'loss' | 'remake';
  lpDelta: number | null;
  /** batched / pending / not recorded: shown instead of a number */
  lpNote?: string;
}

export interface RecapHeader {
  name: string;
  tag: string;
  title: string; // "Today" / "This week"
  subtitle: string; // date or date range
  games: number;
  wins: number;
  losses: number;
  lpNet: number;
  rank: { tier: string; division: string; lp: number; queue: string } | null;
  hiddenCount: number; // games beyond the row cap
  pending: number;
}

const W = 760;
const PAD = 20;
const HEAD_H = 116;
const ROW_H = 68;
const FOOT_H = 36;

const TIER_COLOR: Record<string, string> = {
  IRON: '#8a8282', BRONZE: '#b77b56', SILVER: '#b4bfcb', GOLD: '#e6bd5a', PLATINUM: '#4fc1bc', EMERALD: '#3ccb84',
  DIAMOND: '#7f9eff', MASTER: '#c879e8', GRANDMASTER: '#f0645c', CHALLENGER: '#f8d98a',
};

const COL = { champ: PAD + 22, name: PAD + 84, kda: 400, result: 545, lp: W - PAD - 22 };

export async function renderRecap(h: RecapHeader, games: RecapGame[], assets: AssetSource | null): Promise<Buffer> {
  ensureFonts();
  const sd: StaticData | null = assets && games[0] ? await assets.staticData(games[0].gameVersion).catch(() => null) : null;
  const icons: (Image | null)[] = await Promise.all(games.map(async (g) =>
    assets && sd ? decode(await assets.image(assets.championUrl(sd, g.championId, g.championName))) : null));

  const footer = h.hiddenCount > 0 || h.pending > 0;
  const H = HEAD_H + games.length * ROW_H + (footer ? FOOT_H : 12);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // ---- header ----
  const accent = h.lpNet > 0 ? 'rgba(63,185,80,0.22)' : h.lpNet < 0 ? 'rgba(248,81,73,0.22)' : 'rgba(88,101,242,0.25)';
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, accent);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, 96);

  ctx.fillStyle = C.text;
  ctx.font = font(700, 26);
  const nm = fit(ctx, h.name, 330);
  ctx.fillText(nm, PAD + 8, 42);
  const nw = ctx.measureText(nm).width;
  ctx.fillStyle = C.faint;
  ctx.font = font(400, 18);
  ctx.fillText(`#${h.tag}`, PAD + 14 + nw, 42);

  ctx.fillStyle = C.sub;
  ctx.font = font(600, 16);
  ctx.fillText(`${h.title} · ${h.subtitle}`, PAD + 8, 68);

  if (h.rank) {
    const t = h.rank.tier.charAt(0) + h.rank.tier.slice(1).toLowerCase();
    ctx.fillStyle = TIER_COLOR[h.rank.tier] ?? C.text;
    ctx.font = font(600, 15);
    ctx.fillText(`${isApex(h.rank.tier) ? t : `${t} ${h.rank.division}`} · ${h.rank.lp} LP`, PAD + 8, 90);
    const rw = ctx.measureText(`${isApex(h.rank.tier) ? t : `${t} ${h.rank.division}`} · ${h.rank.lp} LP`).width;
    ctx.fillStyle = C.faint;
    ctx.font = font(400, 14);
    ctx.fillText(h.rank.queue, PAD + 16 + rw, 90);
  }

  ctx.textAlign = 'right';
  ctx.font = font(700, 32);
  ctx.fillStyle = h.lpNet > 0 ? C.win : h.lpNet < 0 ? C.loss : C.text;
  ctx.fillText(`${signed(h.lpNet)} LP`, W - PAD - 8, 46);
  ctx.fillStyle = C.sub;
  ctx.font = font(400, 16);
  const wr = h.games ? Math.round((h.wins / h.games) * 100) : 0;
  ctx.fillText(`${h.wins}W ${h.losses}L · ${wr}%`, W - PAD - 8, 72);
  ctx.textAlign = 'left';

  games.forEach((g, i) => drawGame(ctx, HEAD_H + i * ROW_H, g, icons[i] ?? null, sd));

  if (footer) {
    ctx.fillStyle = C.faint;
    ctx.font = font(400, 13);
    const parts = [
      h.hiddenCount ? `+${h.hiddenCount} older game${h.hiddenCount === 1 ? '' : 's'} not shown` : '',
      h.pending ? `${h.pending} game${h.pending === 1 ? '' : 's'} waiting for LP to update` : '',
    ].filter(Boolean);
    ctx.fillText(parts.join('  ·  '), PAD + 8, H - 13);
  }
  return canvas.toBuffer('image/png');
}

function drawGame(ctx: SKRSContext2D, y: number, g: RecapGame, img: Image | null, sd: StaticData | null) {
  const mid = y + ROW_H / 2;
  const color = g.result === 'win' ? C.win : g.result === 'loss' ? C.loss : C.remake;
  const tint = g.result === 'win' ? 'rgba(63,185,80,0.07)' : g.result === 'loss' ? 'rgba(248,81,73,0.07)' : 'rgba(139,148,158,0.06)';

  ctx.fillStyle = C.panel;
  rounded(ctx, PAD, y + 4, W - 2 * PAD, ROW_H - 8, 10);
  ctx.fill();
  ctx.fillStyle = tint;
  rounded(ctx, PAD, y + 4, W - 2 * PAD, ROW_H - 8, 10);
  ctx.fill();
  ctx.fillStyle = color;
  rounded(ctx, PAD, y + 4, 5, ROW_H - 8, 2);
  ctx.fill();

  // champion
  const name = championName(sd, g.championId, g.championName);
  icon(ctx, img, COL.champ, mid - 22, 44, 9, name);
  ctx.fillStyle = C.text;
  ctx.font = font(700, 19);
  ctx.fillText(fit(ctx, name, 230), COL.name, mid + 7);

  // KDA
  ctx.font = font(700, 20);
  const parts = [String(g.kills), ' / ', String(g.deaths), ' / ', String(g.assists)];
  const colors = [C.text, C.faint, C.loss, C.faint, C.text];
  const widths = parts.map((s) => ctx.measureText(s).width);
  let x = COL.kda - widths.reduce((a, b) => a + b, 0) / 2;
  parts.forEach((s, i) => {
    ctx.fillStyle = colors[i]!;
    ctx.fillText(s, x, mid + 7);
    x += widths[i]!;
  });

  // result pill
  const label = g.result === 'win' ? 'WIN' : g.result === 'loss' ? 'LOSS' : 'REMAKE';
  ctx.font = font(700, 13);
  const pw = ctx.measureText(label).width + 20;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.18;
  rounded(ctx, COL.result - pw / 2, mid - 13, pw, 26, 13);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.fillText(label, COL.result, mid + 5);

  // LP
  ctx.textAlign = 'right';
  if (g.lpDelta !== null && g.result !== 'remake') {
    ctx.font = font(700, 22);
    ctx.fillStyle = g.lpDelta > 0 ? C.win : g.lpDelta < 0 ? C.loss : C.text;
    ctx.fillText(`${signed(g.lpDelta)} LP`, COL.lp, mid + 8);
  } else {
    ctx.font = font(600, 15);
    ctx.fillStyle = C.sub;
    ctx.fillText(g.result === 'remake' ? '±0 LP' : g.lpNote ?? '? LP', COL.lp, mid + 6);
  }
  ctx.textAlign = 'left';
}
