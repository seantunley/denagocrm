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
/**
 * A key of its own, derived from `SESSION_SECRET` rather than being it.
 *
 * `/api/brand/domain-check` is PUBLIC and returns this HMAC for a hostname the
 * caller chooses, which makes it a signing oracle. It was keyed on
 * `SESSION_SECRET` directly — the same key that signs session JWTs. That was
 * safe, and provably so: the fixed `domain-check:` prefix, the lowercasing and
 * host normalisation mean the signed message can never take the shape of a JWT
 * signing input (`base64url.base64url`, which contains `.` and uppercase).
 *
 * But the safety came from the message format, so it would quietly expire the
 * day somebody changed the format. HKDF separates the keys instead: this key
 * cannot verify or forge a session token no matter what is signed with it,
 * because it is not that key. Structural, rather than argued.
 *
 * No new environment variable — one fewer secret to deploy, rotate and get
 * wrong, and rotating `SESSION_SECRET` correctly rotates this too. The proof is
 * recomputed on both sides at verification time and never stored, so changing
 * the key changes nothing for domains already verified.
 */
function proofKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set — domain verification cannot be proven");
  return Buffer.from(
    crypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), Buffer.from("denago:domain-check:v1", "utf8"), 32),
  );
}

export function domainProof(hostname: string): string {
  return crypto.createHmac("sha256", proofKey()).update(`domain-check:${hostname.toLowerCase()}`).digest("hex");
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
