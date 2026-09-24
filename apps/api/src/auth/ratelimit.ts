/**
 * A small sliding-window limiter, in memory.
 *
 * Good enough for one process. It forgets on restart, which slightly favours an attacker;
 * the per-number OTP limit is therefore also enforced in the database, where it survives.
 */
export class RateLimiter {
  readonly #hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records an attempt and reports whether it is within the limit. */
  attempt(key: string, now = Date.now()): boolean {
    const recent = (this.#hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    recent.push(now);
    this.#hits.set(key, recent);
    return recent.length <= this.limit;
  }

  reset(key: string): void {
    this.#hits.delete(key);
  }
}
