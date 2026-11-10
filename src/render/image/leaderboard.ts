import type { AssetSource, StaticData } from '../../assets/ddragon.ts';
import { championName } from '../../assets/ddragon.ts';
import { isApex } from '../../core/rank.ts';
import { signed } from '../format.ts';
import { C, createCanvas, decode, ensureFonts, fit, font, icon, rounded, type Image, type SKRSContext2D } from './canvas.ts';

/** Server leaderboard PNG: one row per player who played in the period. */

export interface LeaderboardRow {
  name: string;
  tag: string;
  region: string;
  games: number;
  wins: number;
  losses: number;
  lpNet: number;
  /** current rank in the row's main queue */
  rank: { tier: string; division: string; lp: number } | null;
  queueLabel: string;
  /** absolute-LP points for the sparkline (start, then after each game) */
  spark: number[];
  /** results in order, for the dots under the name */
  results: boolean[];
  /** most played champion in the period */
  champ: { id: number; name: string; version: string } | null;
}

export interface LeaderboardOptions {
  title: string;
  subtitle: string;
  totals: { games: number; wins: number; losses: number; lpNet: number; players: number; tracked: number };
  hiddenCount: number;
}

const W = 1040;
const PAD = 20;
const HEAD_H = 112;
const ROW_H = 76;
const FOOT_H = 40;

const TIER_COLOR: Record<string, string> = {
  IRON: '#8a8282', BRONZE: '#b77b56', SILVER: '#b4bfcb', GOLD: '#e6bd5a', PLATINUM: '#4fc1bc', EMERALD: '#3ccb84',
  DIAMOND: '#7f9eff', MASTER: '#c879e8', GRANDMASTER: '#f0645c', CHALLENGER: '#f8d98a',
};
const MEDAL = ['#f5c542', '#c9d1d9', '#d08a52'];

const COL = { pos: PAD + 34, champ: PAD + 70, name: PAD + 136, wl: 470, spark: 610, lp: 820, rank: W - PAD - 18 };

export async function renderLeaderboard(rows: LeaderboardRow[], o: LeaderboardOptions, assets: AssetSource | null, sd: StaticData | null): Promise<Buffer> {
  ensureFonts();
  const champIcons: (Image | null)[] = await Promise.all(rows.map(async (r) =>
    assets && sd && r.champ ? decode(await assets.image(assets.championUrl(sd, r.champ.id, r.champ.name))) : null));

  const H = HEAD_H + rows.length * ROW_H + FOOT_H;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // ---- header ----
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, 'rgba(88,101,242,0.28)');
  grad.addColorStop(1, 'rgba(88,101,242,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, 84);
  ctx.fillStyle = C.text;
  ctx.font = font(700, 30);
  ctx.fillText(o.title, PAD + 8, 46);
  ctx.fillStyle = C.sub;
  ctx.font = font(400, 16);
  ctx.fillText(o.subtitle, PAD + 8, 72);

  const t = o.totals;
  const wr = t.games ? Math.round((t.wins / t.games) * 100) : 0;
  ctx.textAlign = 'right';
  ctx.font = font(700, 28);
  ctx.fillStyle = t.lpNet > 0 ? C.win : t.lpNet < 0 ? C.loss : C.text;
  ctx.fillText(`${signed(t.lpNet)} LP`, W - PAD - 8, 46);
  ctx.fillStyle = C.sub;
  ctx.font = font(400, 16);
  ctx.fillText(`${t.games} games · ${t.wins}W ${t.losses}L · ${wr}% · ${t.players}/${t.tracked} played`, W - PAD - 8, 72);

  // column labels
  ctx.fillStyle = C.faint;
  ctx.font = font(600, 12);
  ctx.textAlign = 'center';
  ctx.fillText('RECORD', COL.wl + 50, HEAD_H - 10);
  ctx.fillText('LP TREND', COL.spark + 90, HEAD_H - 10);
  ctx.fillText('LP', COL.lp + 40, HEAD_H - 10);
  ctx.textAlign = 'right';
  ctx.fillText('RANK', COL.rank, HEAD_H - 10);
  ctx.textAlign = 'left';

  rows.forEach((r, i) => drawRow(ctx, HEAD_H + i * ROW_H, i, r, champIcons[i] ?? null, sd));

  // ---- footer ----
  ctx.fillStyle = C.faint;
  ctx.font = font(400, 13);
  const foot = [
    o.hiddenCount ? `${o.hiddenCount} tracked account${o.hiddenCount === 1 ? '' : 's'} without games hidden` : '',
    'LP includes dodges/decay',
  ].filter(Boolean).join('  ·  ');
  ctx.fillText(foot, PAD + 8, H - 14);
  return canvas.toBuffer('image/png');
}

function drawRow(ctx: SKRSContext2D, y: number, i: number, r: LeaderboardRow, champ: Image | null, sd: StaticData | null) {
  const mid = y + ROW_H / 2;
  // card
  ctx.fillStyle = i % 2 === 0 ? C.panel : '#1a1b1f';
  rounded(ctx, PAD, y + 4, W - 2 * PAD, ROW_H - 8, 10);
  ctx.fill();
  if (i < 3) {
    ctx.fillStyle = MEDAL[i]!;
    rounded(ctx, PAD, y + 4, 4, ROW_H - 8, 2);
    ctx.fill();
  }

  // position
  ctx.textAlign = 'center';
  if (i < 3) {
    ctx.fillStyle = MEDAL[i]!;
    ctx.beginPath(); ctx.arc(COL.pos, mid, 15, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#16171a';
    ctx.font = font(700, 16);
    ctx.fillText(String(i + 1), COL.pos, mid + 6);
  } else {
    ctx.fillStyle = C.sub;
    ctx.font = font(700, 18);
    ctx.fillText(String(i + 1), COL.pos, mid + 6);
  }
  ctx.textAlign = 'left';

  // most-played champ
  const cname = r.champ ? championName(sd, r.champ.id, r.champ.name) : '';
  icon(ctx, champ, COL.champ, mid - 25, 50, 10, cname);

  // name + region, results dots
  ctx.fillStyle = C.text;
  ctx.font = font(700, 19);
  const nm = fit(ctx, r.name, 250);
  ctx.fillText(nm, COL.name, mid - 6);
  const nw = ctx.measureText(nm).width;
  ctx.fillStyle = C.faint;
  ctx.font = font(400, 15);
  ctx.fillText(fit(ctx, `#${r.tag}`, Math.max(0, 300 - nw)), COL.name + nw + 4, mid - 6);
  const dots = r.results.slice(-14);
  dots.forEach((w, k) => {
    ctx.fillStyle = w ? C.win : C.loss;
    rounded(ctx, COL.name + k * 13, mid + 8, 10, 10, 3);
    ctx.fill();
  });
  if (r.results.length > 14) {
    ctx.fillStyle = C.faint;
    ctx.font = font(400, 12);
    ctx.fillText(`+${r.results.length - 14}`, COL.name + 14 * 13 + 2, mid + 17);
  }

  // record + winrate bar
  const wr = r.games ? r.wins / r.games : 0;
  ctx.textAlign = 'center';
  ctx.fillStyle = C.text;
  ctx.font = font(600, 17);
  ctx.fillText(`${r.wins}W ${r.losses}L`, COL.wl + 50, mid - 4);
  ctx.fillStyle = '#2d3036';
  rounded(ctx, COL.wl, mid + 8, 100, 7, 4); ctx.fill();
  ctx.fillStyle = wr >= 0.5 ? C.win : C.loss;
  rounded(ctx, COL.wl, mid + 8, Math.max(7, 100 * wr), 7, 4); ctx.fill();
  ctx.fillStyle = C.sub;
  ctx.font = font(400, 12);
  ctx.fillText(`${Math.round(wr * 100)}%`, COL.wl + 50, mid + 30);

  // sparkline
  drawSpark(ctx, r.spark, COL.spark, mid - 20, 180, 40, r.lpNet >= 0 ? C.win : C.loss);

  // LP
  ctx.font = font(700, 24);
  ctx.fillStyle = r.lpNet > 0 ? C.win : r.lpNet < 0 ? C.loss : C.text;
  ctx.fillText(`${signed(r.lpNet)}`, COL.lp + 40, mid + 4);
  ctx.fillStyle = C.faint;
  ctx.font = font(400, 12);
  ctx.fillText('LP', COL.lp + 40, mid + 22);

  // rank
  ctx.textAlign = 'right';
  if (r.rank) {
    const tierName = r.rank.tier.charAt(0) + r.rank.tier.slice(1).toLowerCase();
    ctx.fillStyle = TIER_COLOR[r.rank.tier] ?? C.text;
    ctx.font = font(700, 17);
    ctx.fillText(isApex(r.rank.tier) ? tierName : `${tierName} ${r.rank.division}`, COL.rank, mid - 4);
    ctx.fillStyle = C.sub;
    ctx.font = font(400, 13);
    ctx.fillText(`${r.rank.lp} LP · ${r.queueLabel}`, COL.rank, mid + 16);
  } else {
    ctx.fillStyle = C.sub;
    ctx.font = font(600, 16);
    ctx.fillText('Unranked', COL.rank, mid + 6);
  }
  ctx.textAlign = 'left';
}

function drawSpark(ctx: SKRSContext2D, pts: number[], x: number, y: number, w: number, h: number, color: string) {
  if (pts.length < 2) {
    ctx.fillStyle = C.faint;
    ctx.fillRect(x, y + h / 2, w, 1);
    return;
  }
  const lo = Math.min(...pts), hi = Math.max(...pts);
  const span = Math.max(20, hi - lo);
  const X = (i: number) => x + (i / (pts.length - 1)) * w;
  const Y = (v: number) => y + h - ((v - lo) / span) * h - (span > hi - lo ? (h * (span - (hi - lo))) / span / 2 : 0);
  // baseline at start LP
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(x, Y(pts[0]!), w, 1);
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, color === C.win ? 'rgba(63,185,80,0.30)' : 'rgba(248,81,73,0.30)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath();
  pts.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.lineTo(X(pts.length - 1), y + h);
  ctx.lineTo(X(0), y + h);
  ctx.closePath();
  ctx.fillStyle = g;
  ctx.fill();
  ctx.beginPath();
  pts.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(X(pts.length - 1), Y(pts[pts.length - 1]!), 3.5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

