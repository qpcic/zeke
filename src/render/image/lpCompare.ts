import { formatRank, isApex } from '../../core/rank.ts';
import { signed } from '../format.ts';
import { C, createCanvas, ensureFonts, fit, font, rounded } from './canvas.ts';
import { rankAt, TIER_COLOR, type GraphPoint } from './lpGraph.ts';

/** Several players' LP on one chart, over time (players play different numbers of games). */

const W = 1120;
const H = 620;
const PL = 150, PR = 150, PB = 56;

/** Distinct, readable on the dark background, none of them win green / loss red. */
export const SERIES_COLORS = ['#8b97ff', '#f5c542', '#ff7ab6', '#4fd1c5', '#ff9f43', '#c084fc'];

export interface CompareSeries { name: string; pts: GraphPoint[]; wins: number; losses: number }
export interface CompareOptions { queueLabel: string; tz: string; from: number; to: number; days: number }

const title = (t: string) => t.charAt(0) + t.slice(1).toLowerCase();

export function renderLpCompare(series: CompareSeries[], o: CompareOptions): Buffer {
  ensureFonts();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // ---- title ----
  ctx.fillStyle = C.text;
  ctx.font = font(700, 26);
  ctx.fillText('LP race', 28, 44);
  ctx.fillStyle = C.sub;
  ctx.font = font(400, 16);
  ctx.fillText(`${o.queueLabel} · last ${o.days} day${o.days === 1 ? '' : 's'}`, 28, 70);

  // ---- legend: one chip per player, sorted as given (caller sorts by net LP) ----
  const cols = Math.min(3, series.length);
  const chipW = (W - 56 - (cols - 1) * 12) / cols;
  const rows = Math.ceil(series.length / cols);
  series.forEach((s, i) => {
    const x = 28 + (i % cols) * (chipW + 12);
    const y = 90 + Math.floor(i / cols) * 46;
    ctx.fillStyle = C.panel;
    rounded(ctx, x, y, chipW, 38, 8); ctx.fill();
    ctx.fillStyle = SERIES_COLORS[i % SERIES_COLORS.length]!;
    rounded(ctx, x + 10, y + 14, 22, 10, 4); ctx.fill();
    const net = s.pts.length >= 2 ? s.pts[s.pts.length - 1]!.abs - s.pts[0]!.abs : 0;
    const games = s.wins + s.losses;
    ctx.textAlign = 'right';
    ctx.font = font(700, 16);
    ctx.fillStyle = !games ? C.faint : net > 0 ? C.win : net < 0 ? C.loss : C.text;
    const netText = games ? `${signed(net)} LP` : 'no games';
    ctx.fillText(netText, x + chipW - 12, y + 25);
    const netW = ctx.measureText(netText).width;
    ctx.font = font(400, 13);
    ctx.fillStyle = C.sub;
    const wl = games ? `${s.wins}W ${s.losses}L` : '';
    ctx.fillText(wl, x + chipW - 20 - netW, y + 25);
    const wlW = wl ? ctx.measureText(wl).width + 8 : 0;
    ctx.textAlign = 'left';
    ctx.font = font(600, 15);
    ctx.fillStyle = C.text;
    ctx.fillText(fit(ctx, s.name, chipW - 60 - netW - wlW), x + 42, y + 25);
  });

  const PT = 90 + rows * 46 + 12;
  const pw = W - PL - PR, ph = H - PT - PB;
  const all = series.flatMap((s) => s.pts);

  // ---- scales: x = time, y = absolute LP ----
  let lo = Math.min(...all.map((p) => p.abs)), hi = Math.max(...all.map((p) => p.abs));
  const span = Math.max(160, hi - lo);
  const padY = span * 0.1;
  lo = Math.floor((lo - padY) / 10) * 10;
  hi = Math.ceil((lo + span + 2 * padY) / 10) * 10;
  // zoom to the games (the window only decides which games count), with a little air on the left
  const first = Math.min(...all.map((p) => p.at));
  const t1 = Math.max(o.to, ...all.map((p) => p.at));
  const t0 = Math.max(o.from, first - (t1 - first) * 0.04);
  const X = (t: number) => PL + ((t - t0) / Math.max(1, t1 - t0)) * pw;
  const Y = (abs: number) => PT + ph - ((abs - lo) / (hi - lo)) * ph;

  // ---- division bands (same look as the single graph) ----
  ctx.save();
  rounded(ctx, PL, PT, pw, ph, 10);
  ctx.clip();
  ctx.fillStyle = C.panel;
  ctx.fillRect(PL, PT, pw, ph);
  for (let b = Math.floor(lo / 100) * 100; b < hi; b += 100) {
    const r = rankAt(b);
    const y0 = Y(Math.min(b + 100, hi)), y1 = Y(Math.max(b, lo));
    ctx.globalAlpha = (b / 100) % 2 === 0 ? 0.1 : 0.06;
    ctx.fillStyle = TIER_COLOR[r.tier] ?? '#888';
    ctx.fillRect(PL, y0, pw, y1 - y0);
    ctx.globalAlpha = 1;
    const tierEdge = b < 2800 ? b % 400 === 0 : b === 2800;
    ctx.fillStyle = tierEdge ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)';
    if (b >= lo) ctx.fillRect(PL, Y(b), pw, tierEdge ? 2 : 1);
  }
  ctx.restore();
  ctx.textAlign = 'right';
  for (let b = Math.floor(lo / 100) * 100; b < hi; b += 100) {
    const r = rankAt(b);
    const yTop = Y(Math.min(b + 100, hi)), yBot = Y(Math.max(b, lo));
    if (yBot - yTop < 16) continue;
    ctx.fillStyle = TIER_COLOR[r.tier] ?? C.sub;
    ctx.font = font(600, 14);
    ctx.fillText(isApex(r.tier) || b >= 2800 ? `Master+ ${b - 2800}` : `${title(r.tier)} ${r.division}`, PL - 14, (yTop + yBot) / 2 + 5);
  }
  ctx.textAlign = 'left';

  // ---- lines: each player's steps, extended flat to "now" so who's ahead today is clear ----
  series.forEach((s, i) => {
    if (!s.pts.length) return;
    const color = SERIES_COLORS[i % SERIES_COLORS.length]!;
    ctx.beginPath();
    s.pts.forEach((p, k) => (k ? ctx.lineTo(X(p.at), Y(p.abs)) : ctx.moveTo(X(p.at), Y(p.abs))));
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.stroke();
    const last = s.pts[s.pts.length - 1]!;
    ctx.setLineDash([5, 6]);
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.55;
    ctx.beginPath(); ctx.moveTo(X(last.at), Y(last.abs)); ctx.lineTo(X(t1), Y(last.abs)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    const rad = s.pts.length > 60 ? 2.5 : 4;
    for (const p of s.pts) {
      ctx.beginPath();
      ctx.arc(X(p.at), Y(p.abs), rad, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  });

  // current rank tags at the right edge, nudged apart so they don't overlap
  const tags = series
    .map((s, i) => ({ s, i, last: s.pts[s.pts.length - 1] }))
    .filter((t) => t.last)
    .map((t) => ({ ...t, y: Y(t.last!.abs) }))
    .sort((a, b) => a.y - b.y);
  for (let k = 1; k < tags.length; k++) if (tags[k]!.y - tags[k - 1]!.y < 24) tags[k]!.y = tags[k - 1]!.y + 24;
  ctx.font = font(600, 12);
  for (const t of tags) {
    // in the right gutter, with a short leader from the line's end
    const text = formatRank(rankAt(t.last!.abs));
    const w = Math.min(PR - 20, ctx.measureText(text).width + 12);
    const bx = PL + pw + 12, by = t.y - 10;
    ctx.strokeStyle = SERIES_COLORS[t.i % SERIES_COLORS.length]!;
    ctx.globalAlpha = 0.6; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PL + pw, Y(t.last!.abs)); ctx.lineTo(bx, t.y); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(16,17,20,0.88)';
    rounded(ctx, bx, by, w, 20, 5); ctx.fill();
    ctx.strokeStyle = SERIES_COLORS[t.i % SERIES_COLORS.length]!;
    ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = SERIES_COLORS[t.i % SERIES_COLORS.length]!;
    ctx.fillText(fit(ctx, text, w - 10), bx + 6, by + 14);
  }

  // ---- x axis: dates ----
  ctx.fillStyle = C.faint;
  ctx.font = font(400, 13);
  ctx.textAlign = 'center';
  const short = t1 - t0 < 2 * 86_400_000;
  const fmt = new Intl.DateTimeFormat('en-GB', short
    ? { timeZone: o.tz, weekday: 'short', hour: '2-digit', minute: '2-digit' }
    : { timeZone: o.tz, day: 'numeric', month: 'short' });
  let lastLabel = '';
  for (let k = 0; k <= 6; k++) {
    const t = t0 + (k / 6) * (t1 - t0);
    const label = fmt.format(t);
    if (label === lastLabel) continue;
    lastLabel = label;
    ctx.fillText(label, X(t), PT + ph + 24);
  }
  ctx.textAlign = 'left';
  return canvas.toBuffer('image/png');
}
