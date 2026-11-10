export const fmtDuration = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

export const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

export const kdaRatio = (k: number, d: number, a: number) => (d === 0 ? 'Perfect' : ((k + a) / d).toFixed(2));

/** Terminal/monospace column width of one code point: CJK, Hangul, fullwidth forms and emoji take 2. */
function cpWidth(cp: number): number {
  if (cp < 0x1100) return 1;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}
export const displayWidth = (s: string) => [...s].reduce((n, ch) => n + cpWidth(ch.codePointAt(0)!), 0);

/** Truncate/pad to a fixed display width, for monospace tables (CJK-safe). */
export function cell(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  let t = s;
  if (displayWidth(s) > width) {
    const out: string[] = [];
    let w = 0;
    for (const ch of s) {
      const cw = cpWidth(ch.codePointAt(0)!);
      if (w + cw > width - 1) break;
      out.push(ch);
      w += cw;
    }
    t = out.join('') + '…';
  }
  const pad = ' '.repeat(Math.max(0, width - displayWidth(t)));
  return align === 'left' ? t + pad : pad + t;
}

export const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '±0');
