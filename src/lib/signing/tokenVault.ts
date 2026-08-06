import "server-only";
import { encryptValue, decryptValue } from "@/lib/settings";
import { newSignToken, hashSignToken } from "./tokens";

/**
 * How a signing capability is stored.
 *
 * A signing link is a bearer credential — whoever holds it can open, fill and
 * sign somebody's contract — so it is treated the way a password is, not the way
 * an identifier is:
 *
 *   token           the SHA-256 DIGEST. What the database holds, what lookups
 *                   query, and the only representation that touches a backup.
 *   tokenCiphertext AES-256-GCM of the raw value, so a reminder can repeat the
 *                   SAME link rather than silently invalidating the one already
 *                   sitting in the signer's inbox.
 *   raw             exists only in the URL that was delivered, and in memory for
 *                   the instant it takes to build that URL.
 *
 * The digest is what authenticates. The ciphertext is a convenience, and its
 * absence is not a failure: a row without it (anything created before the
 * encryption key existed, or restored from an older backup) still signs
 * normally, and a reminder rotates it to a fresh capability instead.
 *
 * ── Why not keep the plaintext and encrypt it lazily ────────────────────────
 *
 * An earlier draft stored ciphertext in `token`, kept a separate digest column,
 * and upgraded legacy plaintext rows "on first trusted access". Two problems.
 * The rows nobody touches — the ones sitting in a completed envelope from a year
 * ago — keep their readable token forever, which is precisely the exposure being
 * closed. And storing ciphertext in the column every lookup queries meant the
 * five public routes that resolve a link by its raw value silently stopped
 * matching anything the moment a key was configured, so signing worked in
 * development and CI and would have failed in production only.
 */

export type SignCapability = {
  /** Goes in the URL. Never persisted. */
  raw: string;
  /** Goes in the `token` column. */
  digest: string;
  /** Goes in `tokenCiphertext`. */
  ciphertext: string;
};

export { hashSignToken };

/** A stored capability is exactly 64 lowercase hex characters — see the trigger. */
export const STORED_CAPABILITY_RE = /^[0-9a-f]{64}$/;

export function newSignCapability(): SignCapability {
  const raw = newSignToken();
  return { raw, digest: hashSignToken(raw), ciphertext: encryptValue(raw) };
}

/**
 * Recover the raw capability so an unchanged link can be re-sent.
 *
 * Returns null rather than throwing on anything unusable — a missing value, a
 * row from before the key existed, a ciphertext the current key cannot open.
 * Every caller's fallback is to rotate the capability, which is a strictly safer
 * outcome than failing the send, so an unreadable stored value must not become
 * an exception that stops a reminder going out.
 */
export function revealSignCapability(ciphertext: string | null | undefined): string | null {
  if (!ciphertext) return null;
  try {
    const raw = decryptValue(ciphertext);
    // decryptValue returns its input unchanged when no key is configured. That
    // would hand back the ciphertext as though it were a token, producing a link
    // that cannot resolve; treat anything that is not a well-formed capability
    // as unusable and let the caller rotate.
    return /^[0-9a-f]{48,64}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}
