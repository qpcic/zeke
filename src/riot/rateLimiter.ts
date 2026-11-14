/**
 * Sliding-window rate limiter supporting multiple windows ("20:1,100:120").
 * Riot enforces app limits per routing host and method limits per host+endpoint.
 * Requests are reserved at acquire() time, so concurrent callers can't overshoot.
 */
export interface Window {
  count: number;
  windowMs: number;
}

/** Parses Riot's X-App-Rate-Limit / X-Method-Rate-Limit format "count:seconds,count:seconds". */
export function parseLimitHeader(h: string | null | undefined): Window[] | null {
  if (!h) return null;
  const out: Window[] = [];
  for (const part of h.split(',')) {
    const [c, s] = part.split(':').map(Number);
    if (!c || !s || !Number.isFinite(c) || !Number.isFinite(s)) continue;
    out.push({ count: c, windowMs: s * 1000 });
  }
  return out.length ? out : null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class SlidingWindowLimiter {
  private stamps: number[] = [];
  private blockedUntil = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private windows: Window[],
    /** Extra slack per window to absorb clock skew vs Riot's own counters. */
    private readonly marginMs = 75,
    private readonly now: () => number = Date.now,
  ) {}

  setWindows(w: Window[]): void {
    const same = w.length === this.windows.length &&
      w.every((x, i) => x.count === this.windows[i]?.count && x.windowMs === this.windows[i]?.windowMs);
    if (!same) this.windows = w;
  }

  getWindows(): readonly Window[] {
    return this.windows;
  }

  /** Called on 429: nobody goes through this limiter until `ms` from now. */
  block(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
  }

  /** How long a caller would have to wait right now (0 = free). */
  waitTime(): number {
    const t = this.now();
    let wait = Math.max(0, this.blockedUntil - t);
    for (const w of this.windows) {
      const span = w.windowMs + this.marginMs;
      const inWindow = this.stamps.filter((s) => s > t - span);
      if (inWindow.length >= w.count) {
        // Oldest stamp that must expire for one slot to free up.
        const idx = inWindow.length - w.count;
        const expireAt = inWindow[idx]! + span;
        wait = Math.max(wait, expireAt - t);
      }
    }
    return wait;
  }

  /** Requests in each window right now, e.g. [{ used: 14, count: 20, windowMs: 1000 }]. */
  usage(): { used: number; count: number; windowMs: number }[] {
    const t = this.now();
    return this.windows.map((w) => ({ used: this.stamps.filter((s) => s > t - w.windowMs).length, count: w.count, windowMs: w.windowMs }));
  }

  acquire(): Promise<void> {
    const run = async () => {
      for (;;) {
        const w = this.waitTime();
        if (w <= 0) break;
        await sleep(w);
      }
      const t = this.now();
      this.stamps.push(t);
      const maxSpan = Math.max(0, ...this.windows.map((w) => w.windowMs + this.marginMs));
      while (this.stamps.length && this.stamps[0]! <= t - maxSpan) this.stamps.shift();
    };
    const p = this.chain.then(run);
    this.chain = p.catch(() => {});
    return p;
  }
}
