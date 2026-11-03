/** "count/seconds", e.g. "10/600" = 10 per 10 minutes. */
export function parseRate(spec: string | undefined, fallback: string): { limit: number; windowMs: number } {
  const m = /^(\d+)\/(\d+)$/.exec((spec ?? fallback).trim());
  if (!m || Number(m[1]) < 1 || Number(m[2]) < 1) throw new Error(`Bad rate "${spec}": use count/seconds, e.g. 10/600`);
  return { limit: Number(m[1]), windowMs: Number(m[2]) * 1000 };
}

/**
 * Fixed-window counter per key, in memory. Fine for one server (Phase 3). Each window starts at a key's first hit.
 */
export class RateLimiter {
  private hits = new Map<string, { start: number; count: number }>();
  private lastSweep = 0;

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count one hit. Returns whether it is allowed, and if not, how many seconds until it would be. */
  take(key: string): { ok: boolean; retryAfter: number } {
    const t = this.now();
    if (t - this.lastSweep > this.windowMs) this.sweep(t);
    let w = this.hits.get(key);
    if (!w || t - w.start >= this.windowMs) {
      w = { start: t, count: 0 };
      this.hits.set(key, w);
    }
    if (w.count >= this.limit) return { ok: false, retryAfter: Math.max(1, Math.ceil((w.start + this.windowMs - t) / 1000)) };
    w.count++;
    return { ok: true, retryAfter: 0 };
  }

  private sweep(t: number) {
    this.lastSweep = t;
    for (const [k, w] of this.hits) if (t - w.start >= this.windowMs) this.hits.delete(k);
  }
}
