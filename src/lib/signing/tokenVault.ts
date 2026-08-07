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

/**
 * The raw capability for a link that is about to be sent or shown.
 *
 * Every delivery path needs this and none of them may reach for the stored
 * column: `token` is a DIGEST, and a URL built from it is hashed again by the
 * public route and resolves to nothing — SMTP accepts the message, the CRM
 * records the recipient as sent, and the customer receives a dead link.
 *
 * That defect was fixed for approvals and missed for recipients, which is
 * exactly why this is one function taking a table rather than two copies. The
 * `model` argument is a fixed union, never caller-supplied text.
 *
 * Rotation is the safe fallback rather than a failure: the stored digest is
 * one-way, so an unreadable ciphertext means the old link can never be
 * reproduced. Minting a new one leaves the previous URL dead, which is the
 * correct outcome for a link nobody could rebuild anyway.
 */
export async function usableCapability(
  model: "signatureRecipient" | "approvalStep",
  id: string,
  ciphertext: string | null | undefined,
  /**
   * The digest the caller observed. Rotation is conditioned on it, so two
   * concurrent rotations cannot both succeed and send DIFFERENT raw links —
   * only the last digest written would resolve, leaving an already-delivered
   * link dead on arrival. The loser gets null and reports a failure to prepare
   * rather than sending something that will not work.
   */
  observedDigest?: string | null,
): Promise<string | null> {
  const existing = revealSignCapability(ciphertext);
  if (existing) return existing;
  const rotated = newSignCapability();
  const { basePrisma } = await import("@/lib/db");
  const where = observedDigest
    ? { id, tokenRevokedAt: null, token: observedDigest }
    : { id, tokenRevokedAt: null };
  const data = { token: rotated.digest, tokenCiphertext: rotated.ciphertext };
  // Two calls rather than a union-typed delegate: Prisma's per-model argument
  // types are not mutually assignable, and casting them together would give up
  // the checking that makes this safe in the first place.
  const claimed = model === "signatureRecipient"
    ? await basePrisma.signatureRecipient.updateMany({ where, data })
    : await basePrisma.approvalStep.updateMany({ where, data });
  // A revoked or vanished row must never be handed a working link.
  return claimed.count === 1 ? rotated.raw : null;
}
