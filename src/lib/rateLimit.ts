import crypto from "crypto";
import { headers } from "next/headers";
import { basePrisma } from "./db";

export type RateLimitPolicy = {
  limit: number;
  windowMs: number;
  blockMs: number;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

type RateLimitRow = {
  count: number;
  windowStartedAt: Date;
  blockedUntil: Date | null;
};

export const LOGIN_POLICY: RateLimitPolicy = {
  limit: 5,
  windowMs: 15 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
};

export const OTP_SEND_POLICY: RateLimitPolicy = {
  limit: 3,
  windowMs: 10 * 60 * 1000,
  blockMs: 30 * 60 * 1000,
};

export const OTP_VERIFY_POLICY: RateLimitPolicy = {
  limit: 5,
  windowMs: 15 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
};

/**
 * Public signing endpoints. The token is high-entropy, so this is not a
 * brute-force guard — it bounds ABUSE by someone who legitimately holds (or
 * intercepted) a link: each accepted signature can trigger a Chromium PDF
 * render, a PKCS#7 seal and an email fan-out. Signing is a once-per-document
 * human action, so a real signer never comes close to the limit even after a
 * few validation failures.
 */
export const SIGNING_POLICY: RateLimitPolicy = {
  limit: 10,
  windowMs: 5 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
};

/**
 * Token-gated public actions that MUTATE: approving or rejecting a signing
 * workflow, submitting a survey response. Same shape as signing — a real
 * person does these once, so the limit is only ever reached by a machine.
 */
export const PUBLIC_ACTION_POLICY: RateLimitPolicy = {
  limit: 10,
  windowMs: 5 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
};

/**
 * API-key endpoints (intake, bookings, service lookup). Far more generous:
 * these are machine-to-machine and a busy website can legitimately post a
 * burst of leads. The point is not to police normal traffic — it is that a
 * LEAKED key should not mean unlimited writes until someone notices.
 */
export const API_KEY_POLICY: RateLimitPolicy = {
  limit: 120,
  windowMs: 5 * 60 * 1000,
  blockMs: 5 * 60 * 1000,
};

function retryAfter(blockedUntil: Date | null, now: Date): number {
  if (!blockedUntil) return 0;
  return Math.max(0, Math.ceil((blockedUntil.getTime() - now.getTime()) / 1000));
}

export function rateLimitKey(scope: string, identifier: string): string {
  const pepper = process.env.RATE_LIMIT_PEPPER || process.env.SESSION_SECRET || "local-development";
  return `${scope}:${crypto.createHmac("sha256", pepper).update(identifier).digest("hex")}`;
}

/**
 * The caller's IP, or a sentinel when there is no request to read it from.
 *
 * `headers()` THROWS outside a request scope, and once the public endpoints
 * started throttling, that turned "we cannot see who this is" into "the route
 * explodes". The tenant-guard suite invokes route handlers directly, which is a
 * legitimate way to test a chokepoint end to end, and it took the whole run
 * down (CI caught it; a local `npm run test:unit` does not exercise those
 * routes).
 *
 * A rate limiter has no business being the thing that fails a request. It
 * degrades instead: an unidentifiable caller shares the "unknown" bucket, which
 * is the same bucket a request with no forwarding headers already got.
 */
/**
 * The caller's IP from a header bag — pure, so the rule is testable.
 *
 * Split out of `getRequestIp` because the interesting part is a parsing
 * decision, and the only thing standing between it and a test was `headers()`
 * needing a request scope. See `getRequestIp` for why the order is what it is.
 */
export function clientIpFrom(incoming: { get(name: string): string | null }): string {
  const platform = incoming.get("x-vercel-forwarded-for")?.trim();
  if (platform) return platform;
  const chain = (incoming.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return chain[chain.length - 1] || incoming.get("x-real-ip")?.trim() || "unknown";
}

export async function getRequestIp(): Promise<string> {
  try {
    const incoming = await headers();
    /*
     * NEVER THE LEFTMOST `X-Forwarded-For` ENTRY.
     *
     * This read `split(",")[0]`, and that is the one position in the header a
     * CLIENT controls. `X-Forwarded-For` is a list each proxy appends to, so the
     * leftmost value is whatever the original caller sent — including a caller
     * who invented it. Anyone could pick their own rate-limit bucket by sending
     * `X-Forwarded-For: 1.2.3.4`, and a fresh one per request by changing it.
     *
     * The account-keyed limit still caught credential stuffing against a single
     * login, so what this actually cost was the defence against PASSWORD
     * SPRAYING — one attempt each across many accounts, which by design never
     * trips a per-account counter. Every public throttle keyed on this function
     * had the same hole.
     *
     * Order below, most trustworthy first:
     *   1. `x-vercel-forwarded-for` — set by the platform edge, and stripped
     *      from client requests before a handler ever sees it, so it cannot be
     *      forged from outside.
     *   2. The RIGHTMOST entry of `x-forwarded-for` — the value appended by the
     *      hop nearest us, i.e. by infrastructure we trust rather than by the
     *      caller. If the platform replaces the header outright this is the same
     *      value as the leftmost; if it appends, this is the real one. Correct
     *      either way, which is the point.
     *   3. `x-real-ip`, then the shared "unknown" bucket.
     *
     * A rate limiter must never be the thing that fails a request, so this still
     * degrades to a shared bucket rather than throwing (see the note above).
     */
    return clientIpFrom(incoming);
  } catch {
    return "unknown";
  }
}

export async function checkRateLimit(key: string): Promise<RateLimitResult> {
  const now = new Date();
  try {
    const rows = await basePrisma.$queryRaw<RateLimitRow[]>`
      SELECT "count", "windowStartedAt", "blockedUntil"
      FROM "SecurityRateLimit"
      WHERE "key" = ${key}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row?.blockedUntil || row.blockedUntil <= now) {
      return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterSeconds: 0 };
    }
    return { allowed: false, remaining: 0, retryAfterSeconds: retryAfter(row.blockedUntil, now) };
  } catch {
    // Authentication must remain available while migration 47 is rolling out.
    // Once the table exists, all limiter mutations are persistent and atomic.
    return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterSeconds: 0 };
  }
}

export async function registerRateLimitAttempt(
  key: string,
  policy: RateLimitPolicy
): Promise<RateLimitResult> {
  const now = new Date();
  return basePrisma.$transaction(async (tx) => {
    // Serialize per key with an advisory lock. FOR UPDATE only locks EXISTING
    // rows, so for the very first attempt (no row yet) two concurrent requests
    // both computed count=1 and the ON CONFLICT overwrite kept it at 1 —
    // under-counting the opening burst. The advisory lock makes even the first
    // insert exclusive, so attempts accumulate correctly from the start.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key})::bigint)`;
    const rows = await tx.$queryRaw<RateLimitRow[]>`
      SELECT "count", "windowStartedAt", "blockedUntil"
      FROM "SecurityRateLimit"
      WHERE "key" = ${key}
      FOR UPDATE
    `;
    const row = rows[0];
    if (row?.blockedUntil && row.blockedUntil > now) {
      return { allowed: false, remaining: 0, retryAfterSeconds: retryAfter(row.blockedUntil, now) };
    }

    const expired = !row || now.getTime() - row.windowStartedAt.getTime() >= policy.windowMs;
    const count = expired ? 1 : row.count + 1;
    const windowStartedAt = expired ? now : row.windowStartedAt;
    const blockedUntil = count >= policy.limit ? new Date(now.getTime() + policy.blockMs) : null;

    await tx.$executeRaw`
      INSERT INTO "SecurityRateLimit" ("key", "count", "windowStartedAt", "blockedUntil", "updatedAt")
      VALUES (${key}, ${count}, ${windowStartedAt}, ${blockedUntil}, ${now})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = EXCLUDED."count",
        "windowStartedAt" = EXCLUDED."windowStartedAt",
        "blockedUntil" = EXCLUDED."blockedUntil",
        "updatedAt" = EXCLUDED."updatedAt"
    `;

    return {
      allowed: count < policy.limit,
      remaining: Math.max(0, policy.limit - count),
      retryAfterSeconds: retryAfter(blockedUntil, now),
    };
  });
}

/**
 * Delete limiter rows that can no longer affect a decision.
 *
 * Every key here is derived from caller-supplied input — an IP, or a signing
 * token — so the table grows with traffic and never shrank. Nothing reads a row
 * once its window has passed and its block has lapsed: registerRateLimitAttempt
 * treats an expired window as absent and starts a fresh count. Retention is
 * therefore for forensics only, and a day is generous against the longest
 * policy in play (a 15-minute window plus a 30-minute block).
 *
 * Rows still inside a block are never touched, expired or not — deleting one
 * would hand a blocked caller a clean slate.
 */
export async function pruneRateLimits(retainHours = 24): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - retainHours * 60 * 60 * 1000);
    return await basePrisma.$executeRaw`
      DELETE FROM "SecurityRateLimit"
      WHERE ("blockedUntil" IS NULL OR "blockedUntil" < NOW())
        AND "updatedAt" < ${cutoff}
    `;
  } catch {
    // Housekeeping must never take a cron down with it.
    return 0;
  }
}

export async function clearRateLimit(key: string): Promise<void> {
  try {
    await basePrisma.$executeRaw`DELETE FROM "SecurityRateLimit" WHERE "key" = ${key}`;
  } catch {
    // Safe during rolling deployment before migration 47 reaches every branch.
  }
}
