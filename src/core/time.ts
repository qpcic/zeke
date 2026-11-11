/** Timezone helpers on top of Intl, no deps. All instants are epoch ms. */

interface Parts { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WD: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function zonedParts(t: number, tz: string): Parts {
  const o: Record<string, string> = {};
  for (const p of fmt(tz).formatToParts(t)) o[p.type] = p.value;
  return { year: +o.year!, month: +o.month!, day: +o.day!, hour: +o.hour!, minute: +o.minute!, weekday: WD[o.weekday!]! };
}

/** Offset of tz from UTC at instant t, in ms (e.g. +3_600_000 for CET). */
function offsetAt(t: number, tz: string): number {
  const o: Record<string, string> = {};
  for (const p of fmt(tz).formatToParts(t)) o[p.type] = p.value;
  const asUtc = Date.UTC(+o.year!, +o.month! - 1, +o.day!, +o.hour!, +o.minute!, +o.second!);
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** Epoch ms of local 00:00 on the given calendar date in tz (DST-safe). */
export function zonedMidnight(year: number, month: number, day: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day);
  let t = guess - offsetAt(guess, tz);
  t = guess - offsetAt(t, tz); // second pass fixes DST transition days
  return t;
}

/** Local midnight that starts the day containing t. */
export function startOfLocalDay(t: number, tz: string): number {
  const p = zonedParts(t, tz);
  return zonedMidnight(p.year, p.month, p.day, tz);
}

/** Shift a calendar date by n days (pure calendar math in UTC). */
export function addDays(y: number, m: number, d: number, n: number): [number, number, number] {
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
}

export interface Period { from: number; to: number; key: string; label: string }

const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** The full local day before the one containing t. */
export function previousDay(t: number, tz: string): Period {
  const p = zonedParts(t, tz);
  const [y, m, d] = addDays(p.year, p.month, p.day, -1);
  const from = zonedMidnight(y, m, d, tz);
  const to = zonedMidnight(p.year, p.month, p.day, tz);
  const label = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(from);
  return { from, to, key: ymd(y, m, d), label };
}

/** ISO week number for a calendar date. */
function isoWeek(y: number, m: number, d: number): [number, number] {
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(dt.getUTCFullYear(), 0, 1);
  return [dt.getUTCFullYear(), Math.ceil(((dt.getTime() - yearStart) / 86_400_000 + 1) / 7)];
}

/** The full Mon-Sun local week before the one containing t. */
export function previousWeek(t: number, tz: string): Period {
  const p = zonedParts(t, tz);
  const [ty, tm, td] = addDays(p.year, p.month, p.day, -(p.weekday - 1)); // this week's Monday
  const [fy, fm, fd] = addDays(ty, tm, td, -7);
  const from = zonedMidnight(fy, fm, fd, tz);
  const to = zonedMidnight(ty, tm, td, tz);
  const [wy, wn] = isoWeek(fy, fm, fd);
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short' });
  return { from, to, key: `${wy}-W${String(wn).padStart(2, '0')}`, label: `${f.format(from)} – ${f.format(to - 1)}` };
}

/** Today so far (for on-demand "/recap now"). */
export function today(t: number, tz: string): Period {
  const from = startOfLocalDay(t, tz);
  const p = zonedParts(t, tz);
  return { from, to: t + 1, key: ymd(p.year, p.month, p.day), label: 'Today' };
}

/** This Mon-Sun local week so far. */
export function thisWeek(t: number, tz: string): Period {
  const p = zonedParts(t, tz);
  const [y, m, d] = addDays(p.year, p.month, p.day, -(p.weekday - 1));
  const [wy, wn] = isoWeek(y, m, d);
  return { from: zonedMidnight(y, m, d, tz), to: t + 1, key: `${wy}-W${String(wn).padStart(2, '0')}`, label: 'This week' };
}

/**
 * Rolling window ending now: the last `hours` hours. Used by /daily (24h), /weekly (168h)
 * and leaderboards, so "daily" at 01:00 still includes last night's games.
 */
export function rolling(t: number, hours: number, tz: string): Period {
  const from = t - hours * 3600_000;
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return { from, to: t + 1, key: `last-${hours}h`, label: `${f.format(from)} – now` };
}

/** Leaderboard windows: rolling 24h / 7 days. */
export const recapWindow = (kind: 'daily' | 'weekly', t: number, tz: string) => rolling(t, kind === 'daily' ? 24 : 24 * 7, tz);
export const recapTitle = (kind: 'daily' | 'weekly') => (kind === 'daily' ? 'Past 24h' : 'Past 7 days');

/** /daily window: today since local midnight (default) or the past 24 hours. */
export type DailyWindow = 'today' | '24h';

/** Personal recap windows: /daily is today or past 24h, /weekly is the past 7 days. */
export function personalWindow(kind: 'daily' | 'weekly', window: DailyWindow, t: number, tz: string): Period {
  if (kind === 'weekly') return rolling(t, 24 * 7, tz);
  if (window === '24h') return rolling(t, 24, tz);
  const p = today(t, tz);
  return { ...p, label: new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(p.from) };
}
export const personalTitle = (kind: 'daily' | 'weekly', window: DailyWindow) => (kind === 'weekly' ? 'Past 7 days' : window === '24h' ? 'Past 24h' : 'Today');
export const personalSpan = (kind: 'daily' | 'weekly', window: DailyWindow) => (kind === 'weekly' ? 'in the past 7 days' : window === '24h' ? 'in the past 24 hours' : 'today');

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
