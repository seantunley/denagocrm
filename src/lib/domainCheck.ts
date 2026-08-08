import crypto from "node:crypto";

/**
 * A hostname's proof that it is served by THIS deployment.
 *
 * Once outbound links are built from a tenant's own domain, `verifiedAt` stops
 * being a label and starts being load-bearing: a hostname marked verified but
 * not actually wired up means every signing link, survey invitation and tracked
 * campaign link for that tenant goes to an address that does not resolve. The
 * customer sees a dead link; the tenant sees no signature and no reply, and
 * nothing anywhere errors.
 *
 * Verification was a platform admin clicking a button. That is the right person
 * to assert OWNERSHIP — they are trusted, and this is not a check against them.
 * It is a check against the thing they cannot see from the console: whether DNS
 * points here and whether the domain is attached to the deployment. Those are
 * done by someone else, in two other systems, and the console has no way to know.
 *
 * The proof is an HMAC over the hostname keyed on SESSION_SECRET, so a response
 * carrying it can only have come from a server holding this deployment's secret.
 * Timing-safe compared, because it costs one line.
 */
export function domainProof(hostname: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set — domain verification cannot be proven");
  return crypto.createHmac("sha256", secret).update(`domain-check:${hostname.toLowerCase()}`).digest("hex");
}

/** Constant-time compare, tolerant of a garbage response body. */
export function proofMatches(expected: string, received: unknown): boolean {
  if (typeof received !== "string" || received.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(received, "utf8"));
  } catch {
    return false;
  }
}
