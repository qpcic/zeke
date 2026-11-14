import type { AssetSource } from '../../assets/ddragon.ts';
import { formatTierDiv, isApex } from '../../core/rank.ts';
import type { Canvas } from '@napi-rs/canvas';
import { C, createCanvas, decode, ensureFonts, fit, font, rounded, trimTransparent, type Image } from './canvas.ts';
import { TIER_COLOR } from './lpGraph.ts';

/** Server ladder: accounts sorted by current rank in one queue. */

export interface LadderRow {
  name: string;
  tag: string;
  /** Who it belongs to, e.g. "@Jan · alt" or "tracked" */
  owner: string | null;
  tier: string;
  division: string;
  lp: number;
  wins: number;
  losses: number;
}

export interface LadderOptions { title: string; subtitle: string; footer: string }

const W = 1040;
const PAD = 20;
const HEAD_H = 104;
const ROW_H = 64;
const FOOT_H = 40;
const MEDAL = ['#f5c542', '#c9d1d9', '#d08a52'];
const COL = { pos: PAD + 34, emblem: PAD + 64, name: PAD + 124, rank: 560, record: W - PAD - 18 };

export async function renderLadder(rows: LadderRow[], o: LadderOptions, assets: AssetSource | null): Promise<Buffer> {
  ensureFonts();
  const tiers = [...new Set(rows.map((r) => r.tier))];
  const emblems = new Map<string, Image | Canvas | null>();
  await Promise.all(tiers.map(async (t) => {
    const url = assets ? await assets.emblemUrl(t).catch(() => null) : null;
    const img = url && assets ? await decode(await assets.image(url)).catch(() => null) : null;
    emblems.set(t, img ? trimTransparent(img) : null);
  }));

  const H = HEAD_H + Math.max(1, rows.length) * ROW_H + FOOT_H;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  const top = rows[0];
  const accent = top ? TIER_COLOR[top.tier] ?? '#5865f2' : '#5865f2';
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, `${accent}40`);
  grad.addColorStop(1, `${accent}00`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, 84);
  ctx.fillStyle = C.text;
  ctx.font = font(700, 30);
  ctx.fillText(o.title, PAD + 8, 46);
  ctx.fillStyle = C.sub;
  ctx.font = font(400, 16);
  ctx.fillText(o.subtitle, PAD + 8, 72);
  if (top) {
    ctx.textAlign = 'right';
    ctx.font = font(700, 26);
    ctx.fillStyle = accent;
    ctx.fillText(formatTierDiv(top), W - PAD - 8, 44);
    ctx.fillStyle = C.sub;
    ctx.font = font(400, 16);
    ctx.fillText(`highest · ${top.name}`, W - PAD - 8, 72);
    ctx.textAlign = 'left';
  }

  if (!rows.length) {
    ctx.fillStyle = C.sub;
    ctx.font = font(400, 18);
    ctx.fillText('Nobody is ranked in this queue yet.', PAD + 8, HEAD_H + 38);
  }

  rows.forEach((r, i) => {
    const y = HEAD_H + i * ROW_H;
    const mid = y + ROW_H / 2;
    ctx.fillStyle = i % 2 === 0 ? C.panel : '#1a1b1f';
    rounded(ctx, PAD, y + 4, W - 2 * PAD, ROW_H - 8, 10);
    ctx.fill();

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

    const em = emblems.get(r.tier);
    if (em) {
      const s = Math.min(46 / em.width, 46 / em.height);
      ctx.drawImage(em, COL.emblem + (46 - em.width * s) / 2, mid - (em.height * s) / 2, em.width * s, em.height * s);
    }

    ctx.fillStyle = C.text;
    ctx.font = font(700, 18);
    const nm = fit(ctx, r.name, 250);
    ctx.fillText(nm, COL.name, mid - 3);
    const nw = ctx.measureText(nm).width;
    ctx.fillStyle = C.faint;
    ctx.font = font(400, 14);
    ctx.fillText(fit(ctx, `#${r.tag}`, Math.max(0, 330 - nw)), COL.name + nw + 4, mid - 3);
    if (r.owner) {
      ctx.fillStyle = C.sub;
      ctx.font = font(400, 13);
      ctx.fillText(fit(ctx, r.owner, 380), COL.name, mid + 17);
    }

    ctx.fillStyle = TIER_COLOR[r.tier] ?? C.text;
    ctx.font = font(700, 19);
    const label = isApex(r.tier) ? r.tier.charAt(0) + r.tier.slice(1).toLowerCase() : formatTierDiv(r);
    ctx.fillText(label, COL.rank, mid - 2);
    const lw = ctx.measureText(label).width;
    ctx.fillStyle = C.text;
    ctx.font = font(600, 16);
    ctx.fillText(`${r.lp} LP`, COL.rank + lw + 10, mid - 2);

    const games = r.wins + r.losses;
    ctx.textAlign = 'right';
    ctx.fillStyle = C.text;
    ctx.font = font(700, 16);
    ctx.fillText(`${r.wins}W ${r.losses}L`, COL.record, mid - 2);
    ctx.fillStyle = C.sub;
    ctx.font = font(400, 13);
    ctx.fillText(games ? `${Math.round((r.wins / games) * 100)}% · ${games} games` : 'no games', COL.record, mid + 17);
    ctx.textAlign = 'left';
  });

  ctx.fillStyle = C.faint;
  ctx.font = font(400, 13);
  ctx.fillText(o.footer, PAD + 8, H - 14);
  return canvas.toBuffer('image/png');
}
