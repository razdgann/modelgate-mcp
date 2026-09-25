/**
 * Fixed-window, in-memory rate limiter keyed by principal. Bounded memory:
 * at most `maxKeys` tracked principals (oldest windows evicted first).
 */
export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #buckets = new Map<string, { windowStart: number; count: number }>();

  constructor(options: { limit: number; windowMs?: number; maxKeys?: number }) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs ?? 60_000;
    this.#maxKeys = options.maxKeys ?? 10_000;
  }

  /** Count one hit; returns whether it is allowed and, if not, seconds until the window resets. */
  hit(key: string, now = Date.now()): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const windowStart = now - (now % this.#windowMs);
    let b = this.#buckets.get(key);
    if (!b || b.windowStart !== windowStart) {
      if (!b && this.#buckets.size >= this.#maxKeys) this.#evict(windowStart);
      b = { windowStart, count: 0 };
      this.#buckets.set(key, b);
    }
    b.count++;
    if (b.count > this.#limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((windowStart + this.#windowMs - now) / 1000)),
      };
    }
    return { allowed: true };
  }

  #evict(currentWindow: number) {
    for (const [k, v] of this.#buckets) if (v.windowStart !== currentWindow) this.#buckets.delete(k);
    if (this.#buckets.size >= this.#maxKeys) {
      const first = this.#buckets.keys().next();
      if (!first.done) this.#buckets.delete(first.value);
    }
  }
}
