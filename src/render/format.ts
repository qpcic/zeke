export const fmtDuration = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

export const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

export const kdaRatio = (k: number, d: number, a: number) => (d === 0 ? 'Perfect' : ((k + a) / d).toFixed(2));

/** Truncate/pad to a fixed width (by code points), for monospace tables. */
export function cell(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  const cps = [...s];
  const t = cps.length > width ? cps.slice(0, width - 1).join('') + '…' : s;
  const pad = ' '.repeat(Math.max(0, width - [...t].length));
  return align === 'left' ? t + pad : pad + t;
}

export const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '±0');
