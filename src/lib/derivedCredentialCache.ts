import crypto from "crypto";

/**
 * A short-lived cache for a value DERIVED from a stored credential.
 *
 * Meta's page token is the case that produced this: a system-user token is
 * exchanged for a page-scoped one, the exchange costs a Graph round trip, and the
 * result authorises sends on a particular tenant's Facebook Page. Caching it is
 * obviously right and quietly dangerous, because two separate things have to hold
 * and neither is visible at the call site:
 *
 *   WHOSE it is. One module-level slot in a warm process hands tenant A's page
 *   token to tenant B, and B's reply goes out from A's Page to B's customer.
 *
 *   WHETHER it is still derivable. A hit that short-circuits reading the source
 *   credential keeps working for the rest of the TTL after that credential was
 *   rotated or the integration was disconnected.
 *
 * Both are structural here rather than remembered. The key names the owner. The
 * source credential is a REQUIRED ARGUMENT, so it cannot be read after the cache
 * is consulted — the entry is bound to a fingerprint of it and is not served when
 * that fingerprint changes. A null source evicts rather than falls back.
 *
 * Every rule is on this object so it can be exercised directly, without a Graph
 * API or a database — the previous version could only be argued for by reading
 * the order of statements in a function.
 */

const fingerprint = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

type Entry<T> = { value: T; sourceHash: string; storedAt: number };

export class DerivedCredentialCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { ttlMs: number; now?: () => number }) {
    this.ttlMs = options.ttlMs;
    // Injectable so expiry can be tested at the boundary rather than by sleeping.
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * The cached value for `key`, or `derive`'s result stored under it.
   *
   * `source` is the credential the value is derived FROM, read by the caller
   * before this is called. That ordering is the point: it is what stops a hit
   * short-circuiting the read that would have revealed a rotation.
   */
  async resolve(
    key: string,
    source: string | null | undefined,
    derive: (source: string) => Promise<T | null>,
  ): Promise<T | null> {
    if (!source) {
      // Disconnected or never configured. Serving the derived value until the TTL
      // lapses would keep acting on a credential the workspace has withdrawn.
      this.entries.delete(key);
      return null;
    }

    const sourceHash = fingerprint(source);
    const cached = this.entries.get(key);
    if (cached && cached.sourceHash === sourceHash && this.now() - cached.storedAt < this.ttlMs) {
      return cached.value;
    }

    const derived = await derive(source);
    // A failed derivation leaves the previous entry alone: it is already known to
    // be either stale or absent, and caching the failure would turn one bad Graph
    // response into a TTL of them.
    if (derived === null || derived === undefined) return null;

    const storedAt = this.now();
    // Reclaimed on write, which is the only path guaranteed to run. Without it a
    // long-lived process serving many tenants holds one live credential per tenant
    // for the life of the process: the TTL bounded how long an entry was USED, not
    // how long it was kept.
    for (const [otherKey, entry] of this.entries) {
      if (storedAt - entry.storedAt >= this.ttlMs) this.entries.delete(otherKey);
    }
    this.entries.set(key, { value: derived, sourceHash, storedAt });
    return derived;
  }

  /** Forget one key — for an explicit disconnect, ahead of the next resolve. */
  forget(key: string): void {
    this.entries.delete(key);
  }

  /** How many entries are held. Exists so "does not grow without bound" is testable. */
  get size(): number {
    return this.entries.size;
  }
}
