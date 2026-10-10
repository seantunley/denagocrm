import "server-only";
import crypto from "crypto";
import { safeEqualHex, signingHmac } from "./securityPolicy";

/**
 * Signing in person: a member of staff hands their device to the customer.
 *
 * The customer is standing in front of someone who knows who they are, so a
 * one-time code to their inbox proves less than the person watching them sign.
 * This is how that member of staff vouches for it: the in-person page (which
 * requires a staff session and access to the record) mints a short-lived pass
 * naming one recipient and the staff member, and the signing route accepts it in
 * place of the code — and records the staff member as the witness.
 *
 * The pass is an HMAC over its own contents, so it cannot be forged or pointed
 * at another signer, and it expires on its own. It is deliberately NOT a change
 * to the recipient row: marking them "verified" when the screen opens would also
 * switch the code off for the link in their inbox, for as long as the request
 * stays open, because someone once opened a page.
 */

export type InPersonWitness = { userId: string; name: string };

/** Long enough to read and sign a contract at a desk; short enough to lapse the same visit. */
export const IN_PERSON_PASS_MINUTES = 45;

const DOMAIN = "in-person-signing:v1";

type Payload = { r: string; t: string; u: string; n: string; e: number };

export function mintInPersonPass(
  recipientId: string,
  tenantId: string,
  witness: InPersonWitness,
  now: number = Date.now(),
): string {
  const payload: Payload = {
    r: recipientId,
    t: tenantId,
    u: witness.userId,
    n: witness.name.slice(0, 120),
    e: now + IN_PERSON_PASS_MINUTES * 60_000,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signingHmac(DOMAIN, body)}`;
}

/**
 * The witness a pass names, or null for anything else — malformed, forged,
 * expired, or minted for a different signer or workspace. The recipient and
 * tenant are the ROW's, read by the caller from the database: a pass is only
 * ever honoured for the signer it was issued for.
 */
export function verifyInPersonPass(
  pass: string,
  recipientId: string,
  tenantId: string,
  now: number = Date.now(),
): InPersonWitness | null {
  const [body, mac, ...rest] = pass.split(".");
  if (!body || !mac || rest.length > 0) return null;
  if (!safeEqualHex(mac, signingHmac(DOMAIN, body))) return null;
  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
  } catch {
    return null;
  }
  if (payload.r !== recipientId || payload.t !== tenantId) return null;
  if (typeof payload.e !== "number" || payload.e <= now) return null;
  if (typeof payload.u !== "string" || !payload.u || typeof payload.n !== "string") return null;
  return { userId: payload.u, name: payload.n };
}

/** Binds "witnessed in person" to this signer, this moment and this member of staff. */
export function inPersonEvidenceHash(input: {
  recipientId: string;
  requestId: string;
  witnessUserId: string;
  at: Date;
  ip: string | null;
  userAgent: string | null;
}): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      method: "in_person",
      recipientId: input.recipientId,
      requestId: input.requestId,
      witnessUserId: input.witnessUserId,
      verifiedAt: input.at.toISOString(),
      ip: input.ip,
      userAgent: input.userAgent,
    }))
    .digest("hex");
}
