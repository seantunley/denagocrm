import "server-only";
import { getRequestIp, rateLimitKey, registerRateLimitAttempt, SIGNING_POLICY } from "@/lib/rateLimit";

/**
 * Rate limit for the public signing endpoints (sign + decline).
 *
 * Returns a 429 Response when the caller should be turned away, or null to
 * proceed — so a route guards itself with two lines and no branching.
 *
 * Two keys, because they bound different things:
 *   token — abuse of one signing link, whoever holds it. Each accepted
 *           signature can trigger a PDF render, a PKCS#7 seal and an email
 *           fan-out, so this is the one that protects the workers.
 *   ip    — someone walking well-formed tokens. The token is high-entropy so
 *           guessing one is not realistic; this just stops the attempt from
 *           costing a database round-trip each time.
 *
 * The IP is registered first and BOTH are always registered, so a caller
 * rotating tokens still accumulates against their address.
 */
export async function rateLimitSigning(token: string): Promise<Response | null> {
  const ip = await getRequestIp();
  const byIp = await registerRateLimitAttempt(rateLimitKey("signing-ip", ip), SIGNING_POLICY);
  const byToken = await registerRateLimitAttempt(rateLimitKey("signing-token", token), SIGNING_POLICY);
  if (byIp.allowed && byToken.allowed) return null;

  const retryAfter = Math.max(byIp.retryAfterSeconds, byToken.retryAfterSeconds);
  return new Response("Too many attempts. Try again shortly.", {
    status: 429,
    headers: retryAfter > 0 ? { "Retry-After": String(retryAfter) } : undefined,
  });
}
