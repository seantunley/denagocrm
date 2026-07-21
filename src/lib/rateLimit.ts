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

function retryAfter(blockedUntil: Date | null, now: Date): number {
  if (!blockedUntil) return 0;
  return Math.max(0, Math.ceil((blockedUntil.getTime() - now.getTime()) / 1000));
}

export function rateLimitKey(scope: string, identifier: string): string {
  const pepper = process.env.RATE_LIMIT_PEPPER || process.env.SESSION_SECRET || "local-development";
  return `${scope}:${crypto.createHmac("sha256", pepper).update(identifier).digest("hex")}`;
}

export async function getRequestIp(): Promise<string> {
  const incoming = await headers();
  const forwarded = incoming.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || incoming.get("x-real-ip") || "unknown";
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

export async function clearRateLimit(key: string): Promise<void> {
  try {
    await basePrisma.$executeRaw`DELETE FROM "SecurityRateLimit" WHERE "key" = ${key}`;
  } catch {
    // Safe during rolling deployment before migration 47 reaches every branch.
  }
}
