import "server-only";
import { SIGNING_POLICY } from "@/lib/rateLimit";
import { throttlePublic } from "@/lib/publicThrottle";

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
  return throttlePublic("signing", token, SIGNING_POLICY);
}
