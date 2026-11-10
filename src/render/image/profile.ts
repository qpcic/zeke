import type { AssetSource, StaticData } from '../../assets/ddragon.ts';
import { championName } from '../../assets/ddragon.ts';
import { compareDivision, isApex } from '../../core/rank.ts';
import { C, createCanvas, decode, ensureFonts, fit, font, icon, rounded, trimTransparent, type Image, type SKRSContext2D } from './canvas.ts';

/** Player profile card: icon, name, region, Solo/Flex rank cards with W/L + ladder, top champions. */

export interface QueueCard {
  label: string; // "Solo/Duo" | "Flex" | "Ranked 5s"
  rank: { tier: string; division: string; lp: number } | null;
  wins: number;
  losses: number;
  /** "#152 on EUNE" for Master+, else null */
  ladderPos: string | null;
  hotStreak: boolean;
}
export interface ProfileData {
  name: string;
  tag: string;
  region: string;
  level: number | null;
  iconId: number | null;
  /** Solo/Duo, Flex, Ranked 5s: drawn left to right sorted by rank (highest first, unranked last). */
  queues: QueueCard[];
  champs: { championId: number; points: number; level: number }[];
  /** sum of all champion mastery levels (null if mastery unavailable) */
  masteryScore: number | null;
  /** champions with any mastery points */
  championsPlayed: number | null;
  recent: boolean[]; // last recorded solo results, oldest first
  version: string; // for ddragon
}

const W = 1040;
const H = 540;
const PAD = 24;
const LEFT_W = 300;

const TIER_COLOR: Record<string, string> = {
  IRON: '#8a8282', BRONZE: '#b77b56', SILVER: '#b4bfcb', GOLD: '#e6bd5a', PLATINUM: '#4fc1bc', EMERALD: '#3ccb84',
  DIAMOND: '#7f9eff', MASTER: '#c879e8', GRANDMASTER: '#f0645c', CHALLENGER: '#f8d98a',
};
const title = (t: string) => t.charAt(0) + t.slice(1).toLowerCase();
const fmtPts = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export async function renderProfile(d: ProfileData, assets: AssetSource | null): Promise<Buffer> {
  ensureFonts();
  const sd: StaticData | null = assets ? await assets.staticData(d.version).catch(() => null) : null;
  const get = async (url: string | null) => (assets && url ? decode(await assets.image(url)) : null);
  const queues = sortQueues(d.queues);
  const [pIcon, ...rest] = await Promise.all([
    sd && d.iconId !== null ? get(assets!.profileIconUrl(sd, d.iconId)) : null,
    ...queues.map((q) => (q.rank && assets ? assets.emblemUrl(q.rank.tier).then(get) : null)),
    ...d.champs.map((c) => (sd ? get(assets!.championUrl(sd, c.championId, '')) : null)),
  ]);
  const emblems = rest.slice(0, queues.length);
  const champImgs = rest.slice(queues.length);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // accent from best rank
  const main = queues[0]?.rank ?? null;
  const accent = main ? TIER_COLOR[main.tier] ?? '#5865f2' : '#5865f2';
  const g = ctx.createRadialGradient(PAD + 120, 110, 10, PAD + 120, 110, 420);
  g.addColorStop(0, hexA(accent, 0.28));
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // ---- left: identity (vertically centred) + stats grid at the bottom ----
  const cardTop = PAD, cardH = H - 2 * PAD;
  ctx.fillStyle = C.panel;
  rounded(ctx, PAD, cardTop, LEFT_W, cardH, 16);
  ctx.fill();
  const cx = PAD + LEFT_W / 2;

  const GRID_ROW = 62, GRID_GAP = 10;
  const gridH = 2 * GRID_ROW + GRID_GAP;
  const gridTop = cardTop + cardH - 18 - gridH;
  const IDENTITY_H = 248; // avatar ring top -> region pill bottom
  const RECENT_H = d.recent.length ? 88 : 0;
  const regionTop = cardTop + 12, regionH = gridTop - 12 - regionTop;
  const top = regionTop + Math.max(0, (regionH - IDENTITY_H - RECENT_H) / 2); // y of avatar ring top
  const ay = top + 66; // avatar centre

  ctx.save();
  ctx.beginPath(); ctx.arc(cx, ay, 66, 0, Math.PI * 2); ctx.closePath();
  ctx.fillStyle = accent; ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, ay, 61, 0, Math.PI * 2); ctx.clip();
  if (pIcon) ctx.drawImage(pIcon, cx - 61, ay - 61, 122, 122);
  else { ctx.fillStyle = '#2b2e35'; ctx.fillRect(cx - 61, ay - 61, 122, 122); }
  ctx.restore();
  if (d.level !== null) {
    ctx.font = font(700, 14);
    const lt = String(d.level);
    const lw = ctx.measureText(lt).width + 18;
    ctx.fillStyle = '#0d0e10';
    rounded(ctx, cx - lw / 2, ay + 52, lw, 24, 12); ctx.fill();
    ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = C.text;
    ctx.textAlign = 'center';
    ctx.fillText(lt, cx, ay + 69);
    ctx.textAlign = 'left';
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = C.text;
  ctx.font = font(700, 26);
  ctx.fillText(fit(ctx, d.name, LEFT_W - 30), cx, top + 186);
  ctx.fillStyle = C.faint;
  ctx.font = font(400, 17);
  ctx.fillText(`#${d.tag}`, cx, top + 210);
  ctx.font = font(700, 13);
  const rw = ctx.measureText(d.region).width + 22;
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  rounded(ctx, cx - rw / 2, top + 224, rw, 24, 12); ctx.fill();
  ctx.fillStyle = C.sub;
  ctx.fillText(d.region, cx, top + 241);

  // recent form (only when the bot has recorded games)
  if (d.recent.length) {
    const ry = top + IDENTITY_H + 22;
    ctx.fillStyle = C.faint;
    ctx.font = font(600, 11);
    ctx.fillText(`LAST ${d.recent.length} RECORDED SOLO GAMES`, cx, ry);
    const n = d.recent.length;
    const sz = 16, gap = 5;
    let x = cx - (n * sz + (n - 1) * gap) / 2;
    for (const w of d.recent) {
      ctx.fillStyle = w ? C.win : C.loss;
      rounded(ctx, x, ry + 10, sz, sz, 4); ctx.fill();
      x += sz + gap;
    }
    const wins = d.recent.filter(Boolean).length;
    ctx.fillStyle = C.sub;
    ctx.font = font(600, 13);
    ctx.fillText(`${wins}W ${n - wins}L`, cx, ry + 46);
  }
  ctx.textAlign = 'left';

  // stats grid
  const ranked = d.queues.filter((q) => q.rank);
  const games = ranked.reduce((n, q) => n + q.wins + q.losses, 0);
  const wins = ranked.reduce((n, q) => n + q.wins, 0);
  const wr = games ? Math.round((wins / games) * 100) : null;
  const stats: [string, string, string?][] = [
    ['SEASON GAMES', games ? games.toLocaleString('en-US') : '–'],
    ['OVERALL WR', wr === null ? '–' : `${wr}%`, wr === null ? undefined : wr >= 50 ? C.win : C.loss],
    ['MASTERY SCORE', d.masteryScore !== null ? d.masteryScore.toLocaleString('en-US') : '–'],
    ['CHAMPIONS', d.championsPlayed !== null ? String(d.championsPlayed) : '–'],
  ];
  const cellW = (LEFT_W - 32 - GRID_GAP) / 2;
  stats.forEach(([label, value, color], i) => {
    const gx = PAD + 16 + (i % 2) * (cellW + GRID_GAP);
    const gy = gridTop + Math.floor(i / 2) * (GRID_ROW + GRID_GAP);
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    rounded(ctx, gx, gy, cellW, GRID_ROW, 10); ctx.fill();
    ctx.fillStyle = C.faint;
    ctx.font = font(600, 10);
    ctx.fillText(label, gx + 12, gy + 20);
    ctx.fillStyle = color ?? C.text;
    ctx.font = font(700, 20);
    ctx.fillText(fit(ctx, value, cellW - 24), gx + 12, gy + 47);
  });

  // ---- right: rank cards ----
  const rx = PAD + LEFT_W + 18;
  const rW = W - rx - PAD;
  const GAP = 12;
  const CARD_H = 262;
  const cardW = (rW - GAP * (queues.length - 1)) / queues.length;
  queues.forEach((q, i) => drawQueue(ctx, rx + i * (cardW + GAP), PAD, cardW, CARD_H, q, emblems[i] ?? null, i === 0 && !!q.rank));

  // ---- right: champions ----
  const cy = PAD + CARD_H + 14;
  const ch = H - PAD - cy;
  ctx.fillStyle = C.panel;
  rounded(ctx, rx, cy, rW, ch, 14); ctx.fill();
  ctx.fillStyle = C.faint;
  ctx.font = font(600, 12);
  ctx.fillText('MOST PLAYED · CHAMPION MASTERY', rx + 18, cy + 28);
  const slot = (rW - 36) / 5;
  d.champs.slice(0, 5).forEach((c, i) => {
    const x = rx + 18 + i * slot;
    const name = championName(sd, c.championId, `#${c.championId}`);
    icon(ctx, champImgs[i] ?? null, x + (slot - 76) / 2, cy + 44, 76, 14, name);
    ctx.textAlign = 'center';
    ctx.fillStyle = C.text;
    ctx.font = font(700, 15);
    ctx.fillText(fit(ctx, name, slot - 8), x + slot / 2, cy + 142);
    ctx.fillStyle = C.sub;
    ctx.font = font(400, 13);
    ctx.fillText(`${fmtPts(c.points)} pts · M${c.level}`, x + slot / 2, cy + 162);
    ctx.textAlign = 'left';
  });
  if (!d.champs.length) {
    ctx.fillStyle = C.sub;
    ctx.font = font(600, 15);
    ctx.fillText('No mastery data', rx + 18, cy + 80);
  }
  return canvas.toBuffer('image/png');
}

/**
 * Highest rank first (tier, then division, then LP), unranked last, ties by games played.
 * Tier is compared first because Master/GM/Challenger LP isn't comparable across queues.
 */
export function sortQueues(qs: QueueCard[]): QueueCard[] {
  return [...qs].sort((a, b) => {
    if (!a.rank || !b.rank) return a.rank ? -1 : b.rank ? 1 : 0;
    return compareDivision(b.rank, a.rank) || b.rank.lp - a.rank.lp || b.wins + b.losses - (a.wins + a.losses);
  });
}

/** Compact vertical card (3 across): emblem, tier, LP, ladder, W/L bar. */
function drawQueue(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, q: QueueCard, emblem: Image | null, best: boolean) {
  ctx.fillStyle = C.panel;
  rounded(ctx, x, y, w, h, 14); ctx.fill();
  const color = q.rank ? TIER_COLOR[q.rank.tier] ?? C.text : C.faint;
  ctx.fillStyle = color;
  rounded(ctx, x, y, w, 4, 2); ctx.fill();
  const cx = x + w / 2;

  ctx.fillStyle = C.faint;
  ctx.font = font(600, 12);
  ctx.fillText(q.label.toUpperCase(), x + 16, y + 26);
  ctx.textAlign = 'right';
  if (q.hotStreak) {
    ctx.fillStyle = C.gold;
    ctx.fillText('HOT', x + w - 16, y + 26);
  } else if (best) {
    ctx.fillStyle = color;
    ctx.fillText('BEST', x + w - 16, y + 26);
  }
  ctx.textAlign = 'left';

  if (!q.rank) {
    crest(ctx, cx, y + 92, 34, C.faint, '–');
    ctx.textAlign = 'center';
    ctx.fillStyle = C.sub;
    ctx.font = font(700, 20);
    ctx.fillText('Unranked', cx, y + 160);
    ctx.textAlign = 'left';
    return;
  }

  const es = 84;
  if (emblem) ctx.drawImage(trimTransparent(emblem), cx - es / 2, y + 40, es, es);
  else crest(ctx, cx, y + 40 + es / 2, 36, color, q.rank.tier.charAt(0));

  ctx.textAlign = 'center';
  ctx.fillStyle = color;
  ctx.font = font(700, 21);
  const label = isApex(q.rank.tier) ? title(q.rank.tier) : `${title(q.rank.tier)} ${q.rank.division}`;
  ctx.fillText(fit(ctx, label, w - 20), cx, y + 150);
  ctx.fillStyle = C.text;
  ctx.font = font(600, 16);
  ctx.fillText(`${q.rank.lp} LP`, cx, y + 172);
  if (q.ladderPos) {
    ctx.fillStyle = C.sub;
    ctx.font = font(600, 13);
    ctx.fillText(fit(ctx, q.ladderPos, w - 20), cx, y + 194);
  }
  ctx.textAlign = 'left';

  // W/L + bar
  const games = q.wins + q.losses;
  const wr = games ? q.wins / games : 0;
  const by = y + h - 36;
  ctx.fillStyle = C.text;
  ctx.font = font(600, 14);
  ctx.fillText(`${q.wins}W ${q.losses}L`, x + 16, by);
  ctx.textAlign = 'right';
  ctx.fillStyle = wr >= 0.5 ? C.win : C.loss;
  ctx.fillText(`${Math.round(wr * 100)}%`, x + w - 16, by);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#2d3036';
  rounded(ctx, x + 16, by + 9, w - 32, 7, 4); ctx.fill();
  ctx.fillStyle = wr >= 0.5 ? C.win : C.loss;
  rounded(ctx, x + 16, by + 9, Math.max(7, (w - 32) * wr), 7, 4); ctx.fill();
}

function crest(ctx: SKRSContext2D, cx: number, cy: number, r: number, color: string, letter: string) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    const px = cx + r * Math.cos(a), py = cy + r * Math.sin(a);
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = hexA(color, 0.18);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = font(700, 30);
  ctx.textAlign = 'center';
  ctx.fillText(letter, cx, cy + 11);
  ctx.textAlign = 'left';
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
