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

/**
 * The passkey (WebAuthn) login ceremony — both halves, keyed per IP.
 *
 * NOT a brute-force guard, and it would be a poor one: forging an assertion
 * needs the private key, so guessing buys nothing no matter how many attempts
 * are allowed. It exists for the two things the 2026-09-01 retest found actually
 * missing, both of which the password path had and this one did not:
 *
 *   1. A ceiling on unauthenticated work. Both routes are in PUBLIC_PATHS, and
 *      each call ran a challenge generation or a database lookup plus signature
 *      verification, for anyone, unbounded.
 *   2. Somewhere for a failed attempt to be RECORDED. `/login` throttles and
 *      calls recordFailedLogin; the passkey route logged successes only, so a
 *      sustained campaign against it left no trace anywhere. The monitoring gap
 *      was the more valuable half of that finding.
 *
 * DELIBERATELY GENEROUS, and the reason is the constrained user rather than the
 * attacker. Staff sit behind one office NAT, so this bucket is shared by
 * everyone in the building: a tight limit modelled on one person's behaviour
 * (LOGIN_POLICY's 5) would lock out colleagues who had done nothing. 30 per 15
 * minutes still bounds a script to a trivial rate, while an office of ten each
 * signing in twice never approaches it.
 *
 * Verification follows the LOGIN_POLICY pattern — count FAILURES, clear on
 * success — so an ordinary signing-in staffer never accumulates against it at
 * all. Options has no notion of failure and counts every call.
 */
export const PASSKEY_POLICY: RateLimitPolicy = {
  limit: 30,
  windowMs: 15 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
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
 * Is a proxy we TRUST in front of this process?
 *
 * The whole question, made explicit instead of inferred from the shape of a
 * header. `X-Forwarded-For` is only evidence of anything when something we
 * trust wrote it; on a directly-exposed deployment the caller writes the entire
 * header themselves, and no amount of parsing rescues that.
 *
 * `VERCEL` is set in every Vercel runtime. `TRUST_PROXY_HEADERS` is the escape
 * hatch for a self-hosted deployment that genuinely does sit behind a proxy
 * that overwrites the header — opt-in, because getting this wrong silently
 * turns rate limiting off rather than breaking anything visibly.
 */
function behindTrustedProxy(): boolean {
  return Boolean(process.env.VERCEL) || process.env.TRUST_PROXY_HEADERS === "true";
}

/**
 * The caller's IP from a header bag — pure, so the rule is testable.
 *
 * ── WHY THE TRUST BOUNDARY IS A PARAMETER ───────────────────────────────────
 *
 * An earlier version of this took the RIGHTMOST `X-Forwarded-For` entry, on the
 * reasoning that the leftmost is client-controlled. Both halves of that were
 * wrong for this deployment, and the correction matters more than the code:
 *
 *   - Vercel's documented behaviour is that it **overwrites** `X-Forwarded-For`
 *     and does not forward external IPs, "to prevent IP spoofing". So the
 *     original leftmost read was never spoofable here — the audit finding that
 *     prompted this was mistaken about the platform.
 *   - "Rightmost is the trusted hop" is not a general rule either. It identifies
 *     the nearest proxy, which is only the client when the chain is exactly one
 *     hop deep; and with no trusted proxy at all the attacker supplies every
 *     entry, so rightmost is exactly as forged as leftmost.
 *
 * What is actually true: a forwarded header means something only when a trusted
 * proxy wrote it. So trust is decided by DEPLOYMENT, not by parsing.
 *
 *   1. `x-vercel-forwarded-for` — set by the platform edge, and per Vercel's
 *      docs the variant that survives when another proxy sits on top.
 *   2. `x-forwarded-for`, LEFTMOST, but only behind a trusted proxy — because
 *      that proxy replaced the header, so its first entry is the real client.
 *   3. Otherwise `unknown`. Not a failure: an unidentifiable caller shares one
 *      bucket, which is strictly better than letting a caller mint unlimited
 *      buckets by inventing header values.
 *
 * NOTE for the enterprise "Trusted Proxy" feature: it makes Vercel honour a
 * customer-supplied `X-Forwarded-For`. If that is ever enabled, the leftmost
 * entry becomes caller-controlled again and this must be revisited.
 */
export function clientIpFrom(
  incoming: { get(name: string): string | null },
  options: { trustedProxy: boolean },
): string {
  const first = (value: string | null | undefined): string =>
    (value ?? "").split(",")[0]?.trim() ?? "";

  const platform = first(incoming.get("x-vercel-forwarded-for"));
  if (platform) return platform;

  if (options.trustedProxy) {
    return first(incoming.get("x-forwarded-for")) || incoming.get("x-real-ip")?.trim() || "unknown";
  }

  // No trusted proxy: every forwarding header is caller-controlled, so none of
  // them may key a limit. One shared bucket, deliberately.
  return "unknown";
}

export async function getRequestIp(): Promise<string> {
  try {
    const incoming = await headers();
    /*
     * The rule itself lives in `clientIpFrom`, with the reasoning — including
     * the correction that Vercel OVERWRITES `X-Forwarded-For` to prevent
     * spoofing, so the original leftmost read was never forgeable here.
     *
     * A rate limiter must never be the thing that fails a request, so an
     * unreadable header bag degrades to the shared "unknown" bucket rather than
     * throwing (see the note above `getRequestIp`).
     */
    return clientIpFrom(incoming, { trustedProxy: behindTrustedProxy() });
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
