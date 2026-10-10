import "server-only";
import { safeEqualHex, signingHmac } from "./securityPolicy";

/**
 * "This browser is the one that just signed."
 *
 * A finished document revokes its links, and a revoked link is answered with a
 * message, never the document — so the person who signed thirty seconds ago
 * cannot fetch what they signed with the link alone, and must not be able to:
 * the link is also in their inbox, their history, and anywhere it was forwarded.
 *
 * The sign route therefore hands the signing browser a pass in a cookie it
 * cannot read or copy out (HttpOnly), scoped to the one address that serves the
 * signed copy, naming the one signer, and gone in a quarter of an hour. The
 * signed-copy route honours that and nothing else. Same construction as the
 * in-person pass (inPerson.ts): an HMAC over its own contents under a key
 * derived for this purpose alone, so neither kind can be passed off as the other.
 *
 * Not issued for an in-person signature: that browser belongs to a member of
 * staff, and the customer is about to hand it back.
 */

/** Long enough for the copy to be sealed and downloaded; short enough that a shared computer forgets. */
export const SIGNED_COPY_PASS_MINUTES = 15;
export const SIGNED_COPY_COOKIE = "sg_signed";

const DOMAIN = "signed-copy:v1";

type Payload = { r: string; t: string; e: number };

export function mintSignedCopyPass(recipientId: string, tenantId: string, now: number = Date.now()): string {
  const payload: Payload = { r: recipientId, t: tenantId, e: now + SIGNED_COPY_PASS_MINUTES * 60_000 };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signingHmac(DOMAIN, body)}`;
}

/** True only for an unexpired pass minted for THIS signer in THIS workspace — both read from the row by the caller. */
export function verifySignedCopyPass(pass: string | undefined, recipientId: string, tenantId: string, now: number = Date.now()): boolean {
  const [body, mac, ...rest] = (pass ?? "").split(".");
  if (!body || !mac || rest.length > 0) return false;
  if (!safeEqualHex(mac, signingHmac(DOMAIN, body))) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
    return payload.r === recipientId && payload.t === tenantId && typeof payload.e === "number" && payload.e > now;
  } catch {
    return false;
  }
}

/** Where the signed copy is served for one link — the only path the cookie is ever sent to. */
export function signedCopyPath(token: string): string {
  return `/api/signing/${token}/signed`;
}

/** How the cookie carrying the pass is set: unreadable by script, sent to one path, never cross-site. */
export function signedCopyCookieOptions(token: string) {
  return {
    path: signedCopyPath(token),
    maxAge: SIGNED_COPY_PASS_MINUTES * 60,
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production",
  };
}
