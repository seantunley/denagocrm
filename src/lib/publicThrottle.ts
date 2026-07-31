import "server-only";
import {
  getRequestIp,
  rateLimitKey,
  registerRateLimitAttempt,
  type RateLimitPolicy,
} from "@/lib/rateLimit";

/**
 * Rate limiting for endpoints reachable without a staff session.
 *
 * Generalises what the signing endpoints already do. Two keys, and the ORDER
 * is load-bearing:
 *
 *   ip      registered first, and it SHORT-CIRCUITS.
 *   subject the token or API key the caller presented.
 *
 * The subject is caller-supplied, so registering it unconditionally lets an
 * attacker mint one permanent SecurityRateLimit row per made-up value while
 * being told 429 — being blocked has to stop the row being written, not just
 * the work. Checking the IP first caps new subject rows at the IP's own limit.
 * (This exact bug shipped in the signing limiter and was caught in review.)
 *
 * The IP key is still registered on every request that reaches here, so a
 * caller rotating subjects keeps accumulating against their address.
 *
 * Rows are pruned by pruneRateLimits() from the automations cron.
 *
 * Two public routes are NOT throttled on purpose, because throttling them would
 * break legitimate behaviour to prevent something not worth preventing:
 *
 *   /api/track/*      Gmail and Outlook fetch tracking pixels through their own
 *                     image proxies, so a whole campaign's opens arrive from a
 *                     handful of provider IPs. An IP limit would break open
 *                     tracking wholesale. The abuse it would stop is an
 *                     inflated open count.
 *   /api/unsubscribe  Mail clients prefetch links, so a limit can swallow a
 *                     genuine opt-out. Blocking an unsubscribe is a compliance
 *                     problem far worse than the abuse.
 */
export type ThrottleVerdict = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export async function checkPublicThrottle(
  scope: string,
  subject: string | null,
  policy: RateLimitPolicy,
): Promise<ThrottleVerdict> {
  const ip = await getRequestIp();
  const byIp = await registerRateLimitAttempt(rateLimitKey(`${scope}-ip`, ip), policy);
  if (!byIp.allowed) return { allowed: false, retryAfterSeconds: byIp.retryAfterSeconds };

  if (subject) {
    const bySubject = await registerRateLimitAttempt(rateLimitKey(`${scope}-subject`, subject), policy);
    if (!bySubject.allowed) return { allowed: false, retryAfterSeconds: bySubject.retryAfterSeconds };
  }

  return { allowed: true };
}

/** Route-handler form: a 429 Response to return, or null to carry on. */
export async function throttlePublic(
  scope: string,
  subject: string | null,
  policy: RateLimitPolicy,
): Promise<Response | null> {
  const verdict = await checkPublicThrottle(scope, subject, policy);
  if (verdict.allowed) return null;
  return new Response("Too many attempts. Try again shortly.", {
    status: 429,
    headers: verdict.retryAfterSeconds > 0 ? { "Retry-After": String(verdict.retryAfterSeconds) } : undefined,
  });
}
