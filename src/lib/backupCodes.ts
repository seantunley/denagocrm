import bcrypt from "bcryptjs";

/**
 * Backup codes — the way back in when the authenticator is gone.
 *
 * These exist for the worst day: a lost phone, a wiped device, a factory reset
 * on the way to a meeting. That makes two properties non-negotiable, and both
 * were broken.
 *
 * ── 1. The code shown must be the code accepted ─────────────────────────────
 *
 * Codes are displayed as `ABCD-EFGH`. Enrolment hashed them with the hyphen
 * removed, while the login stripped only WHITESPACE — so anyone typing the code
 * exactly as it was shown to them was rejected, and only someone who happened to
 * omit the hyphen got in. The recovery path failed in precisely the situation it
 * exists for, and it failed silently: indistinguishable from "wrong code".
 *
 * One normaliser, used on both sides, is the fix. It strips everything that is
 * not a letter or a digit, so the hyphen, a stray space, a trailing newline from
 * a paste and any lowercase typing all resolve to the same value.
 *
 * This is backward compatible with codes already issued: those hashes were taken
 * over the uppercase code with its hyphen removed, which is exactly what this
 * produces. Nobody's existing backup codes are invalidated by this change — they
 * start working.
 *
 * ── 2. A single-use code must be usable exactly once ────────────────────────
 *
 * Consumption was read-modify-write: parse the list, splice the used code out,
 * write the list back. Two requests arriving together both read the same list,
 * both match the same code, both write the same shortened list, and both are
 * handed a session. One code, two sign-ins. `consumeBackupCode` closes that with
 * a compare-and-swap on the stored value, so the second writer's update matches
 * no row and is refused.
 */

/** The one definition of "the same code", used when hashing AND when comparing. */
export function normaliseBackupCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Hash a freshly generated code for storage. Never store the code itself. */
export function hashBackupCode(code: string): Promise<string> {
  return bcrypt.hash(normaliseBackupCode(code), 10);
}

export type BackupCodeMatch = {
  /** The remaining hashes, for the caller's compare-and-swap write. */
  remaining: string[];
  /** Serialised form of `remaining`, ready to store. */
  remainingJson: string;
};

/**
 * Find the supplied code in a stored list and return the list without it.
 *
 * Returns null when nothing matches. Every candidate is compared even after a
 * match would be found, because bailing early makes the response time depend on
 * WHICH code was supplied, and that difference is measurable across attempts.
 *
 * This does not write anything — the caller performs the conditional update, so
 * the read and the write can be checked against each other.
 */
export async function matchBackupCode(
  storedJson: string | null | undefined,
  supplied: string,
): Promise<BackupCodeMatch | null> {
  if (!storedJson) return null;
  let hashes: string[];
  try {
    const parsed: unknown = JSON.parse(storedJson);
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) return null;
    hashes = parsed;
  } catch {
    // A corrupt list must not throw the caller into a 500 on the login path.
    return null;
  }

  const candidate = normaliseBackupCode(supplied);
  if (!candidate) return null;

  let matchedIndex = -1;
  for (let index = 0; index < hashes.length; index += 1) {
    const isMatch = await bcrypt.compare(candidate, hashes[index]).catch(() => false);
    if (isMatch && matchedIndex === -1) matchedIndex = index;
  }
  if (matchedIndex === -1) return null;

  const remaining = hashes.filter((_, index) => index !== matchedIndex);
  return { remaining, remainingJson: JSON.stringify(remaining) };
}
