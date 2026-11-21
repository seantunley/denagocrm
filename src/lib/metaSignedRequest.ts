import crypto from "crypto";

/**
 * Meta's `signed_request` (data-deletion and deauthorize callbacks): `<signature>.<payload>`, both base64url, the
 * signature an HMAC-SHA256 of the payload STRING with the app secret. Null unless the signature is right and the
 * payload names a user — a forged or garbled request is never acted on.
 */
export function parseMetaSignedRequest(signedRequest: string, appSecret: string): { userId: string } | null {
  if (!signedRequest || !appSecret || signedRequest.length > 4096) return null;
  const [encodedSig, payload, extra] = signedRequest.split(".");
  if (!encodedSig || !payload || extra !== undefined) return null;
  const expected = crypto.createHmac("sha256", appSecret).update(payload).digest();
  const given = Buffer.from(encodedSig, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { algorithm?: string; user_id?: unknown };
    if (String(data.algorithm ?? "").toUpperCase() !== "HMAC-SHA256") return null;
    const userId = typeof data.user_id === "string" || typeof data.user_id === "number" ? String(data.user_id) : "";
    return /^\d{1,32}$/.test(userId) ? { userId } : null;
  } catch {
    return null;
  }
}
