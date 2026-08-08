import crypto from "crypto";

/** Per-recipient signing token — 56 hex chars, matching the existing /sign scheme. */
export function newSignToken(): string {
  return crypto.randomBytes(28).toString("hex");
}

export const SIGN_TOKEN_RE = /^[a-f0-9]{48,64}$/;

export function isValidSignToken(t: string): boolean {
  return SIGN_TOKEN_RE.test(t);
}

/**
 * How a raw capability out of a URL becomes the value stored in the database.
 *
 * It lives here, next to the format check every public route already imports,
 * because the two belong to the same decision: a route validates the shape of
 * what arrived and then hashes it to look it up. Keeping them apart is how a
 * route ends up querying the raw value — which is what happened before, and it
 * fails only in production, where a configured encryption key made the stored
 * value stop matching the plaintext being searched for.
 *
 * The corresponding lookup is always `where: { token: hashSignToken(raw) }`.
 * There is no query anywhere that matches a readable secret.
 */
export function hashSignToken(raw: string): string {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}
