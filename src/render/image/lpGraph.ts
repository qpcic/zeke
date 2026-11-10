import { absoluteLp, formatRank, isApex, TIERS } from '../../core/rank.ts';
import type { PlayerMatchRow } from '../../db/repo.ts';
import { signed } from '../format.ts';
import { C, createCanvas, ensureFonts, font, rounded } from './canvas.ts';

/** LP-over-games chart on tier/division bands. */

const W = 1120;
const H = 580;
const PL = 150, PR = 48, PT = 96, PB = 92;

const TIER_COLOR: Record<string, string> = {
  IRON: '#7a7272', BRONZE: '#a8714f', SILVER: '#a9b4c0', GOLD: '#e0b552', PLATINUM: '#4fb6b2', EMERALD: '#34c27a',
  DIAMOND: '#7898ff', MASTER: '#c06be0', GRANDMASTER: '#ec5a52', CHALLENGER: '#f6d27a',
};
const DIVS = ['IV', 'III', 'II', 'I'];
const title = (t: string) => t.charAt(0) + t.slice(1).toLowerCase();

function rankAt(abs: number): { tier: string; division: string; lp: number } {
  if (abs >= 2800) return { tier: 'MASTER', division: 'I', lp: abs - 2800 };
  const a = Math.max(0, abs);
  return { tier: TIERS[Math.floor(a / 400)]!, division: DIVS[Math.floor((a % 400) / 100)]!, lp: a % 100 };
}

export interface GraphPoint { abs: number; win: boolean | null; at: number; label?: string }

/** Turn stored games into plot points; prepends the pre-first-game LP when known. */
export function pointsFromHistory(rows: PlayerMatchRow[]): GraphPoint[] {
  const pts: GraphPoint[] = [];
  const usable = rows.filter((r) => r.tier_after && !(r.note === 'batched' && r.lp_delta === null));
  const first = usable[0];
  if (first && first.lp_delta !== null && first.note !== 'placement') {
    const after = absoluteLp({ tier: first.tier_after!, division: first.div_after ?? '', lp: first.lp_after ?? 0 });
    pts.push({ abs: after - first.lp_delta, win: null, at: first.game_end - 1 });
  }
  for (const r of usable) {
    pts.push({ abs: absoluteLp({ tier: r.tier_after!, division: r.div_after ?? '', lp: r.lp_after ?? 0 }), win: !!r.win, at: r.game_end });
  }
  return pts;
}

export interface GraphOptions {
  name: string;
  queueLabel: string;
  tz: string;
  /** all games in the window incl. ones without LP, for the W/L strip */
  results: boolean[];
}

export function renderLpGraph(pts: GraphPoint[], o: GraphOptions): Buffer {
  ensureFonts();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  const net = pts.length >= 2 ? pts[pts.length - 1]!.abs - pts[0]!.abs : 0;
  const wins = o.results.filter(Boolean).length;
  const losses = o.results.length - wins;

  // ---- title ----
  ctx.fillStyle = C.text;
  ctx.font = font(700, 26);
  ctx.fillText(o.name, 28, 44);
  ctx.fillStyle = C.sub;
  ctx.font = font(400, 16);
  ctx.fillText(`${o.queueLabel} · last ${o.results.length} game${o.results.length === 1 ? '' : 's'}`, 28, 70);
  ctx.textAlign = 'right';
  ctx.font = font(700, 30);
  ctx.fillStyle = net > 0 ? C.win : net < 0 ? C.loss : C.text;
  ctx.fillText(`${signed(net)} LP`, W - 28, 46);
  ctx.fillStyle = C.sub;
  ctx.font = font(400, 16);
  const wr = o.results.length ? Math.round((wins / o.results.length) * 100) : 0;
  ctx.fillText(`${wins}W ${losses}L · ${wr}% WR`, W - 28, 70);
  ctx.textAlign = 'left';

  const pw = W - PL - PR, ph = H - PT - PB;
  if (pts.length < 2) {
    ctx.fillStyle = C.sub;
    ctx.font = font(600, 20);
    ctx.textAlign = 'center';
    ctx.fillText('Not enough recorded games yet: play a few ranked games while tracked.', W / 2, PT + ph / 2);
    return canvas.toBuffer('image/png');
  }

  // ---- scales ----
  let lo = Math.min(...pts.map((p) => p.abs)), hi = Math.max(...pts.map((p) => p.abs));
  const span = Math.max(160, hi - lo);
  const padY = span * 0.12;
  lo = Math.floor((lo - padY) / 10) * 10;
  hi = Math.ceil((lo + span + 2 * padY) / 10) * 10;
  const X = (i: number) => PL + (pts.length === 1 ? pw / 2 : (i / (pts.length - 1)) * pw);
  const Y = (abs: number) => PT + ph - ((abs - lo) / (hi - lo)) * ph;

  // ---- bands: each division (or each 100 LP in Master+) ----
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
    // tier boundary: stronger line
    const tierEdge = b < 2800 ? b % 400 === 0 : b === 2800;
    ctx.fillStyle = tierEdge ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)';
    if (b >= lo) ctx.fillRect(PL, Y(b), pw, tierEdge ? 2 : 1);
  }
  ctx.restore();

  // band labels in the left gutter
  ctx.textAlign = 'right';
  for (let b = Math.floor(lo / 100) * 100; b < hi; b += 100) {
    const r = rankAt(b);
    const yTop = Y(Math.min(b + 100, hi)), yBot = Y(Math.max(b, lo));
    if (yBot - yTop < 16) continue;
    ctx.fillStyle = TIER_COLOR[r.tier] ?? C.sub;
    ctx.font = font(600, 14);
    const label = isApex(r.tier) || b >= 2800 ? `Master+ ${b - 2800}` : `${title(r.tier)} ${r.division}`;
    ctx.fillText(label, PL - 14, (yTop + yBot) / 2 + 5);
  }
  ctx.textAlign = 'left';

  // ---- peak ----
  const peakIdx = pts.reduce((bi, p, i) => (p.abs > pts[bi]!.abs ? i : bi), 0);
  const peak = pts[peakIdx]!;
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = 'rgba(245,197,66,0.5)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(PL, Y(peak.abs)); ctx.lineTo(PL + pw, Y(peak.abs)); ctx.stroke();
  ctx.setLineDash([]);

  // ---- area + line ----
  const grad = ctx.createLinearGradient(0, PT, 0, PT + ph);
  grad.addColorStop(0, 'rgba(88,101,242,0.35)');
  grad.addColorStop(1, 'rgba(88,101,242,0)');
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p.abs)) : ctx.moveTo(X(i), Y(p.abs))));
  ctx.lineTo(X(pts.length - 1), PT + ph);
  ctx.lineTo(X(0), PT + ph);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p.abs)) : ctx.moveTo(X(i), Y(p.abs))));
  ctx.strokeStyle = '#8b97ff';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.stroke();

  const rad = pts.length > 70 ? 3 : pts.length > 35 ? 4 : 5.5;
  pts.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(X(i), Y(p.abs), rad, 0, Math.PI * 2);
    ctx.fillStyle = p.win === null ? C.sub : p.win ? C.win : C.loss;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = C.bg;
    ctx.stroke();
  });

  // peak + current labels
  const tag = (text: string, x: number, y: number, color: string, below = false) => {
    ctx.font = font(600, 13);
    const w = ctx.measureText(text).width + 14;
    const bx = Math.min(Math.max(x - w / 2, PL + 4), PL + pw - w - 4);
    const by = below ? Math.min(PT + ph - 26, y + 12) : Math.max(PT + 4, y - 32);
    ctx.fillStyle = 'rgba(16,17,20,0.9)';
    rounded(ctx, bx, by, w, 22, 6); ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(text, bx + 7, by + 15);
  };
  const last = pts[pts.length - 1]!;
  const showPeak = peakIdx !== pts.length - 1;
  if (showPeak) tag(`Peak · ${formatRank(rankAt(peak.abs))}`, X(peakIdx), Y(peak.abs), C.gold);
  const crowded = showPeak && Math.abs(X(peakIdx) - X(pts.length - 1)) < 240 && Math.abs(Y(peak.abs) - Y(last.abs)) < 44;
  tag(formatRank(rankAt(last.abs)), X(pts.length - 1), Y(last.abs), '#c9cfff', crowded);

  // ---- x axis dates ----
  ctx.fillStyle = C.faint;
  ctx.font = font(400, 13);
  ctx.textAlign = 'center';
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: o.tz, day: 'numeric', month: 'short' });
  const ticks = Math.min(7, pts.length);
  let lastLabel = '';
  for (let k = 0; k < ticks; k++) {
    const i = Math.round((k / Math.max(1, ticks - 1)) * (pts.length - 1));
    const label = fmt.format(pts[i]!.at);
    if (label === lastLabel) continue;
    lastLabel = label;
    ctx.fillText(label, X(i), PT + ph + 22);
  }
  ctx.textAlign = 'left';

  // ---- W/L strip ----
  const sy = H - 44;
  const n = o.results.length;
  const cell = Math.min(18, (pw - (n - 1) * 3) / n);
  const total = n * cell + (n - 1) * 3;
  let sx = PL + (pw - total) / 2;
  ctx.fillStyle = C.faint;
  ctx.font = font(600, 12);
  ctx.textAlign = 'right';
  ctx.fillText('RESULTS', PL - 14, sy + cell / 2 + 4);
  ctx.textAlign = 'left';
  for (const w of o.results) {
    ctx.fillStyle = w ? C.win : C.loss;
    rounded(ctx, sx, sy, cell, Math.max(cell, 10), 3); ctx.fill();
    sx += cell + 3;
  }
  return canvas.toBuffer('image/png');
}
