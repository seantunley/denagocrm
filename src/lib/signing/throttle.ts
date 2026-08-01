import "server-only";
import { getRequestIp, rateLimitKey, registerRateLimitAttempt, SIGNING_POLICY } from "@/lib/rateLimit";

/**
 * Rate limit for the public signing endpoints (sign + decline).
 *
 * Returns a 429 Response when the caller should be turned away, or null to
 * proceed — so a route guards itself with two lines and no branching.
 *
 * Two keys, because they bound different things:
 *   ip    — someone walking well-formed tokens. Checked FIRST, and it
 *           short-circuits.
 *   token — abuse of one signing link, whoever holds it. Each accepted
 *           signature can trigger a PDF render, a PKCS#7 seal and an email
 *           fan-out, so this is the one that protects the workers.
 *
 * The order is load-bearing, not stylistic. Registering both unconditionally
 * meant every request minted a row keyed on a caller-supplied token — and any
 * random 48–64 hex string passes the format check, so an attacker could grow
 * SecurityRateLimit without bound while "rate limited", because being blocked
 * did not stop the row being written. Checking the IP first caps new token rows
 * at the IP's own limit per window.
 *
 * The IP key is still registered on EVERY request that gets this far, so a
 * caller rotating tokens accumulates against their address exactly as before.
 *
 * Rows are pruned by pruneRateLimits() from the automations cron; nothing here
 * relies on them living forever.
 */
export async function rateLimitSigning(token: string): Promise<Response | null> {
  const ip = await getRequestIp();
  const byIp = await registerRateLimitAttempt(rateLimitKey("signing-ip", ip), SIGNING_POLICY);
  if (!byIp.allowed) return tooManyAttempts(byIp.retryAfterSeconds);

  const byToken = await registerRateLimitAttempt(rateLimitKey("signing-token", token), SIGNING_POLICY);
  if (!byToken.allowed) return tooManyAttempts(byToken.retryAfterSeconds);

  return null;
}

function tooManyAttempts(retryAfterSeconds: number): Response {
  return new Response("Too many attempts. Try again shortly.", {
    status: 429,
    headers: retryAfterSeconds > 0 ? { "Retry-After": String(retryAfterSeconds) } : undefined,
  });
}
