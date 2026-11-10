import { createCanvas, GlobalFonts, loadImage, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../assets/fonts');
let fontsReady = false;

/** Bundled Inter for Latin; CJK/Cyrillic etc. fall back to system fonts (Malgun Gothic, Noto CJK…). */
export function ensureFonts(): void {
  if (fontsReady) return;
  for (const f of ['Inter_400Regular', 'Inter_600SemiBold', 'Inter_700Bold']) {
    const p = join(FONT_DIR, `${f}.ttf`);
    if (existsSync(p)) GlobalFonts.registerFromPath(p, 'LBInter');
  }
  fontsReady = true;
}

const FALLBACK = '"Malgun Gothic", "Yu Gothic UI", "Microsoft YaHei UI", "Noto Sans CJK KR", "Noto Sans CJK JP", "Noto Sans", sans-serif';
export const font = (weight: 400 | 600 | 700, px: number) => `${weight} ${px}px LBInter, ${FALLBACK}`;

export const C = {
  bg: '#16171a',
  panel: '#1e1f24',
  blue: '#1b2433',
  red: '#331c22',
  blueAccent: '#4c8dff',
  redAccent: '#ff5c6c',
  text: '#eceef2',
  sub: '#9aa0aa',
  faint: '#5d636e',
  win: '#3fb950',
  loss: '#f85149',
  remake: '#8b949e',
  gold: '#f5c542',
  purple: '#b28dff',
  highlight: 'rgba(255,255,255,0.07)',
};

export function rounded(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Truncate with an ellipsis to fit maxW using the current ctx.font. */
export function fit(ctx: SKRSContext2D, s: string, maxW: number): string {
  if (ctx.measureText(s).width <= maxW) return s;
  const cps = [...s];
  while (cps.length > 1 && ctx.measureText(cps.join('') + '…').width > maxW) cps.pop();
  return cps.join('') + '…';
}

export async function decode(buf: Buffer | null): Promise<Image | null> {
  if (!buf) return null;
  try {
    return await loadImage(buf);
  } catch {
    return null;
  }
}

/** Draw an icon clipped to a rounded rect, or a neutral placeholder with initials. */
export function icon(ctx: SKRSContext2D, img: Image | null, x: number, y: number, size: number, r = 6, label = '') {
  ctx.save();
  rounded(ctx, x, y, size, size, r);
  ctx.clip();
  if (img) {
    ctx.drawImage(img, x, y, size, size);
  } else {
    ctx.fillStyle = '#2b2e35';
    ctx.fillRect(x, y, size, size);
    if (label) {
      ctx.fillStyle = C.sub;
      ctx.font = font(600, Math.max(9, Math.round(size * 0.36)));
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label.slice(0, 2), x + size / 2, y + size / 2 + 1);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }
  }
  ctx.restore();
}

export function pill(ctx: SKRSContext2D, text: string, x: number, y: number, bg: string, fg = '#111') {
  ctx.font = font(700, 12);
  const w = ctx.measureText(text).width + 12;
  ctx.fillStyle = bg;
  rounded(ctx, x, y, w, 18, 9);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.fillText(text, x + 6, y + 13);
  return w;
}

export { createCanvas };
export type { SKRSContext2D, Image };
