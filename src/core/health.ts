/**
 * In-memory health data for `$admin health`: process start, last poll tick, recent
 * errors from the log, and Riot API request metrics. Resets on restart by design.
 */

export interface TickInfo { at: number; ms: number; players: number; games: number; requests: number; ok: boolean }

export interface ApiCall { at: number; method: string; status: number | 'network'; ms: number }

const KEEP_MS = 2 * 3_600_000;

export class ApiMetrics {
  private calls: ApiCall[] = [];
  constructor(private readonly now: () => number = Date.now) {}

  record(method: string, status: number | 'network', ms: number): void {
    const t = this.now();
    this.calls.push({ at: t, method, status, ms });
    // prune occasionally, not on every call
    if (this.calls.length % 200 === 0) this.calls = this.calls.filter((c) => c.at > t - KEEP_MS);
  }

  summary(windowMs = 3_600_000) {
    const since = this.now() - windowMs;
    const calls = this.calls.filter((c) => c.at > since);
    const by = (f: (c: ApiCall) => boolean) => calls.filter(f).length;
    const lat = calls.filter((c) => typeof c.status === 'number' && c.status < 400).map((c) => c.ms).sort((a, b) => a - b);
    const pct = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))]! : 0);
    const methods = new Map<string, { n: number; errors: number }>();
    for (const c of calls) {
      const m = methods.get(c.method) ?? { n: 0, errors: 0 };
      m.n++;
      if (c.status === 'network' || (c.status >= 400 && c.status !== 404)) m.errors++;
      methods.set(c.method, m);
    }
    return {
      total: calls.length,
      ok: by((c) => typeof c.status === 'number' && c.status < 400),
      notFound: by((c) => c.status === 404),
      rateLimited: by((c) => c.status === 429),
      server: by((c) => typeof c.status === 'number' && c.status >= 500),
      otherClient: by((c) => typeof c.status === 'number' && c.status >= 400 && c.status < 500 && c.status !== 404 && c.status !== 429),
      network: by((c) => c.status === 'network'),
      p50: pct(0.5),
      p95: pct(0.95),
      methods: [...methods].sort((a, b) => b[1].n - a[1].n),
    };
  }
}

export class Health {
  readonly startedAt: number;
  lastTick: TickInfo | null = null;
  ticks = 0;
  failedTicks = 0;
  private errors: { at: number; msg: string }[] = [];

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  tick(t: TickInfo): void {
    this.lastTick = t;
    this.ticks++;
    if (!t.ok) this.failedTicks++;
  }

  /** Feed every log line; keeps the last few that look like errors. */
  noteLog(msg: string): void {
    if (!/fail|error|exception|429|could not/i.test(msg)) return;
    this.errors.push({ at: this.now(), msg: msg.split('\n')[0]!.slice(0, 180) });
    if (this.errors.length > 8) this.errors.shift();
  }

  recentErrors(n = 5) {
    return this.errors.slice(-n).reverse();
  }
}

/** Process-wide instance (the bot runs one service per process). */
export const health = new Health();
