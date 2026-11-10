import type { AssetSource, StaticData } from '../../assets/ddragon.ts';
import { championName } from '../../assets/ddragon.ts';
import { isApex } from '../../core/rank.ts';
import { C, createCanvas, decode, ensureFonts, fit, font, icon, rounded, type Image, type SKRSContext2D } from './canvas.ts';

/** Player profile card: icon, name, region, Solo/Flex rank cards with W/L + ladder, top champions. */

export interface QueueCard {
  label: string; // "Solo/Duo" | "Flex"
  rank: { tier: string; division: string; lp: number } | null;
  wins: number;
  losses: number;
  /** "#152 on EUNE" for Master+, else null */
  ladderPos: string | null;
  /** "top 0.04%" / "≈ top 12%" */
  topPercent: string | null;
  hotStreak: boolean;
}
export interface ProfileData {
  name: string;
  tag: string;
  region: string;
  level: number | null;
  iconId: number | null;
  solo: QueueCard;
  flex: QueueCard;
  champs: { championId: number; points: number; level: number }[];
  recent: boolean[]; // last recorded solo results, oldest first
  version: string; // for ddragon
}

const W = 1040;
const H = 470;
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
  const [pIcon, soloEmblem, flexEmblem, ...champImgs] = await Promise.all([
    sd && d.iconId !== null ? get(assets!.profileIconUrl(sd, d.iconId)) : null,
    d.solo.rank && assets ? assets.emblemUrl(d.solo.rank.tier).then(get) : null,
    d.flex.rank && assets ? assets.emblemUrl(d.flex.rank.tier).then(get) : null,
    ...d.champs.map((c) => (sd ? get(assets!.championUrl(sd, c.championId, '')) : null)),
  ]);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // accent from best rank
  const main = d.solo.rank ?? d.flex.rank;
  const accent = main ? TIER_COLOR[main.tier] ?? '#5865f2' : '#5865f2';
  const g = ctx.createRadialGradient(PAD + 120, 110, 10, PAD + 120, 110, 420);
  g.addColorStop(0, hexA(accent, 0.28));
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // ---- left: identity ----
  ctx.fillStyle = C.panel;
  rounded(ctx, PAD, PAD, LEFT_W, H - 2 * PAD, 16);
  ctx.fill();
  const cx = PAD + LEFT_W / 2;
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, 112, 66, 0, Math.PI * 2); ctx.closePath();
  ctx.fillStyle = accent; ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, 112, 61, 0, Math.PI * 2); ctx.clip();
  if (pIcon) ctx.drawImage(pIcon, cx - 61, 51, 122, 122);
  else { ctx.fillStyle = '#2b2e35'; ctx.fillRect(cx - 61, 51, 122, 122); }
  ctx.restore();
  if (d.level !== null) {
    ctx.font = font(700, 14);
    const lt = String(d.level);
    const lw = ctx.measureText(lt).width + 18;
    ctx.fillStyle = '#0d0e10';
    rounded(ctx, cx - lw / 2, 164, lw, 24, 12); ctx.fill();
    ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = C.text;
    ctx.textAlign = 'center';
    ctx.fillText(lt, cx, 181);
    ctx.textAlign = 'left';
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = C.text;
  ctx.font = font(700, 26);
  ctx.fillText(fit(ctx, d.name, LEFT_W - 30), cx, 232);
  ctx.fillStyle = C.faint;
  ctx.font = font(400, 17);
  ctx.fillText(`#${d.tag}`, cx, 256);
  // region pill
  ctx.font = font(700, 13);
  const rw = ctx.measureText(d.region).width + 22;
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  rounded(ctx, cx - rw / 2, 270, rw, 24, 12); ctx.fill();
  ctx.fillStyle = C.sub;
  ctx.fillText(d.region, cx, 287);

  // recent form
  if (d.recent.length) {
    ctx.fillStyle = C.faint;
    ctx.font = font(600, 11);
    ctx.fillText(`LAST ${d.recent.length} RECORDED SOLO GAMES`, cx, 334);
    const n = d.recent.length;
    const s = 16, gap = 5;
    let x = cx - (n * s + (n - 1) * gap) / 2;
    for (const w of d.recent) {
      ctx.fillStyle = w ? C.win : C.loss;
      rounded(ctx, x, 344, s, s, 4); ctx.fill();
      x += s + gap;
    }
    const wins = d.recent.filter(Boolean).length;
    ctx.fillStyle = C.sub;
    ctx.font = font(600, 13);
    ctx.fillText(`${wins}W ${n - wins}L`, cx, 382);
  }
  ctx.textAlign = 'left';

  // ---- right: rank cards ----
  const rx = PAD + LEFT_W + 18;
  const rW = W - rx - PAD;
  const cardW = (rW - 16) / 2;
  drawQueue(ctx, rx, PAD, cardW, 200, d.solo, soloEmblem ?? null);
  drawQueue(ctx, rx + cardW + 16, PAD, cardW, 200, d.flex, flexEmblem ?? null);

  // ---- right: champions ----
  const cy = PAD + 216;
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

function drawQueue(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, q: QueueCard, emblem: Image | null) {
  ctx.fillStyle = C.panel;
  rounded(ctx, x, y, w, h, 14); ctx.fill();
  const color = q.rank ? TIER_COLOR[q.rank.tier] ?? C.text : C.faint;
  ctx.fillStyle = color;
  rounded(ctx, x, y, w, 4, 2); ctx.fill();

  ctx.fillStyle = C.faint;
  ctx.font = font(600, 12);
  ctx.fillText(q.label.toUpperCase(), x + 18, y + 28);
  if (q.hotStreak) {
    ctx.fillStyle = C.gold;
    ctx.textAlign = 'right';
    ctx.fillText('HOT STREAK', x + w - 18, y + 28);
    ctx.textAlign = 'left';
  }

  if (!q.rank) {
    ctx.fillStyle = C.sub;
    ctx.font = font(700, 24);
    ctx.fillText('Unranked', x + 18, y + 90);
    return;
  }
  // emblem (image if available, else a tier-coloured crest)
  const ex = x + 18, ey = y + 44, es = 86;
  if (emblem) ctx.drawImage(emblem, ex, ey, es, es);
  else crest(ctx, ex + es / 2, ey + es / 2, 38, color, q.rank.tier.charAt(0));

  const tx = ex + es + 14;
  ctx.fillStyle = color;
  ctx.font = font(700, 24);
  const label = isApex(q.rank.tier) ? title(q.rank.tier) : `${title(q.rank.tier)} ${q.rank.division}`;
  ctx.fillText(fit(ctx, label, w - (tx - x) - 14), tx, ey + 30);
  ctx.fillStyle = C.text;
  ctx.font = font(600, 17);
  ctx.fillText(`${q.rank.lp} LP`, tx, ey + 54);
  if (q.ladderPos || q.topPercent) {
    ctx.fillStyle = C.sub;
    ctx.font = font(400, 13);
    ctx.fillText(fit(ctx, [q.ladderPos, q.topPercent].filter(Boolean).join(' · '), w - (tx - x) - 14), tx, ey + 76);
  }

  // W/L + bar
  const games = q.wins + q.losses;
  const wr = games ? q.wins / games : 0;
  const by = y + h - 44;
  ctx.fillStyle = C.text;
  ctx.font = font(600, 15);
  ctx.fillText(`${q.wins}W ${q.losses}L`, x + 18, by);
  ctx.textAlign = 'right';
  ctx.fillStyle = wr >= 0.5 ? C.win : C.loss;
  ctx.fillText(`${Math.round(wr * 100)}%`, x + w - 18, by);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#2d3036';
  rounded(ctx, x + 18, by + 10, w - 36, 8, 4); ctx.fill();
  ctx.fillStyle = wr >= 0.5 ? C.win : C.loss;
  rounded(ctx, x + 18, by + 10, Math.max(8, (w - 36) * wr), 8, 4); ctx.fill();
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
