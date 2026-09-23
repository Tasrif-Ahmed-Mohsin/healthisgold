/**
 * Message de-duplication.
 *
 * Meta retries a webhook until it receives a 200, so the same message will arrive more than
 * once as a matter of routine — after a timeout, a deploy, or a slow response. Without this,
 * one patient describing chest pain becomes three identical cases in a clinical queue, and a
 * coordinator wastes time working out whether they are the same person.
 *
 * In-memory for now, which means duplicates can slip through across a restart. That is
 * acceptable while there is a single process and every case reaches a human anyway; it moves
 * into the case store as a uniqueness constraint on the external id when persistence lands.
 */

export interface SeenMessagesOptions {
  /** Upper bound on retained ids, so a busy day cannot exhaust memory. */
  readonly maxEntries?: number;
  /** How long an id is remembered. Meta's retry window is hours, not days. */
  readonly ttlMs?: number;
  readonly now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class SeenMessages {
  readonly #entries = new Map<string, number>();
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: SeenMessagesOptions = {}) {
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Records an id and reports whether it had been seen before.
   *
   * Check-and-record in one call, deliberately: a separate `has` then `add` invites a caller
   * to do the check and forget the record.
   */
  check(id: string): boolean {
    const now = this.#now();
    const expiry = this.#entries.get(id);

    if (expiry !== undefined && expiry > now) {
      return true;
    }

    this.#entries.set(id, now + this.#ttlMs);
    this.#prune(now);
    return false;
  }

  get size(): number {
    return this.#entries.size;
  }

  #prune(now: number): void {
    if (this.#entries.size <= this.#maxEntries) return;

    for (const [id, expiry] of this.#entries) {
      if (expiry <= now) this.#entries.delete(id);
    }

    // Map iterates in insertion order, so the front of it is the oldest. If expiry alone
    // did not free enough, drop from there.
    for (const id of this.#entries.keys()) {
      if (this.#entries.size <= this.#maxEntries) break;
      this.#entries.delete(id);
    }
  }
}
