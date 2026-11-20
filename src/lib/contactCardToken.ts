import crypto from "node:crypto";

/*
 * The signed "Save my contact" token (lib/contactCardServer.ts): `<workspace>.<person>.<mac>`. Public in every signature,
 * so it is signed, not looked up — nobody can make one for a person or workspace they weren't sent. It never expires (a
 * signature in an old email keeps working); the card route decides whether the card is still offered.
 */

/** A key of its own, derived from SESSION_SECRET (as lib/domainCheck.ts does): it can never sign or verify a session. */
function cardKey(): Buffer | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), Buffer.from("denago:contact-card:v1", "utf8"), 32));
}

const ID = /^[A-Za-z0-9_-]{6,64}$/;
const mac = (key: Buffer, tenantId: string, userId: string) =>
  crypto.createHmac("sha256", key).update(`contact-card:${tenantId}:${userId}`).digest("base64url").slice(0, 32);

/** The person's token, or null when this deployment has no secret to sign with (then no link is shown at all). */
export function contactCardToken(tenantId: string, userId: string): string | null {
  const key = cardKey();
  return key && ID.test(tenantId) && ID.test(userId) ? `${tenantId}.${userId}.${mac(key, tenantId, userId)}` : null;
}

/** Who a token is for, or null for anything not signed by this deployment. Constant-time on the signature. */
export function verifyContactCardToken(token: string): { tenantId: string; userId: string } | null {
  const key = cardKey();
  const [tenantId, userId, given, extra] = token.split(".");
  if (!key || extra !== undefined || !tenantId || !userId || !given || !ID.test(tenantId) || !ID.test(userId)) return null;
  const want = Buffer.from(mac(key, tenantId, userId));
  const got = Buffer.from(given);
  return got.length === want.length && crypto.timingSafeEqual(got, want) ? { tenantId, userId } : null;
}

export const contactCardPath = (token: string) => `/api/contact-card/${token}`;
export const contactQrPath = (token: string) => `/api/contact-card/${token}/qr`;

/** The links a signature carries for this person under the owner's choice; {} when off or unsignable. */
export function contactCardLinks(
  tenantId: string | null,
  userId: string,
  choice: "link" | "qr" | undefined,
  origin: string,
): { contactCardUrl?: string; contactQrUrl?: string } {
  const token = choice && tenantId ? contactCardToken(tenantId, userId) : null;
  if (!token) return {};
  const base = origin.replace(/\/$/, "");
  return { contactCardUrl: `${base}${contactCardPath(token)}`, ...(choice === "qr" ? { contactQrUrl: `${base}${contactQrPath(token)}` } : {}) };
}
