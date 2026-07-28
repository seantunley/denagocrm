/**
 * PURE, dependency-free decision helpers for managing platform administrators.
 * No Prisma, no `server-only`, no env reads — every branch is a plain function of
 * its arguments, so the lockout rules are unit-testable WITHOUT a database (same
 * posture as tenantAdmin.ts).
 *
 * The rules all defend one property: **the platform must never become
 * unadministrable.** Unlike a tenant, there is no higher authority to recover it —
 * lose every active platform admin and the only way back is SQL by hand.
 */

export type GuardResult = { ok: true } | { ok: false; error: string };

const OK: GuardResult = { ok: true };

/** Minimum password strength, matching the CRM's admin createUser floor. */
export function validPlatformPassword(password: string): boolean {
  return password.length >= 12 && /[A-Za-z]/.test(password) && /\d/.test(password);
}

/**
 * Disabling an admin. Two ways this bricks the platform:
 *   - disabling YOURSELF, which locks you out of the surface you are standing on;
 *   - disabling the LAST active admin, leaving nobody who can administer anything.
 *
 * `otherActiveAdminCount` is the number of OTHER admins currently active (not
 * counting the target, not counting the actor if they are the target).
 */
export function canDisablePlatformAdmin(
  actorId: string,
  targetId: string,
  otherActiveAdminCount: number,
): GuardResult {
  if (actorId === targetId) {
    return {
      ok: false,
      error: "You cannot disable your own account — you would lock yourself out of the console.",
    };
  }
  if (otherActiveAdminCount < 1) {
    return {
      ok: false,
      error: "At least one platform admin must stay active. Create another before disabling this one.",
    };
  }
  return OK;
}

/**
 * Deleting an admin. Same reasoning as disabling, and deletion is worse because it
 * is irreversible — prefer disabling. Kept as a separate function so the messages
 * can say the right thing.
 */
export function canDeletePlatformAdmin(
  actorId: string,
  targetId: string,
  otherActiveAdminCount: number,
): GuardResult {
  if (actorId === targetId) {
    return {
      ok: false,
      error: "You cannot delete your own account.",
    };
  }
  if (otherActiveAdminCount < 1) {
    return {
      ok: false,
      error: "At least one platform admin must remain. Create another before deleting this one.",
    };
  }
  return OK;
}

/**
 * Changing your OWN password requires the current one, so a borrowed session
 * (unlocked laptop, stolen cookie) cannot silently take ownership of the account
 * by resetting the credential it did not know.
 */
export function canChangeOwnPassword(
  currentPasswordMatches: boolean,
  newPassword: string,
): GuardResult {
  if (!currentPasswordMatches) {
    return { ok: false, error: "Current password is incorrect." };
  }
  if (!validPlatformPassword(newPassword)) {
    return {
      ok: false,
      error: "New password must be at least 12 characters and contain both letters and numbers.",
    };
  }
  return OK;
}

/**
 * Resetting SOMEONE ELSE'S password. Deliberately allowed without knowing their
 * current one — that is the point of an administrative reset — but never for
 * yourself, because that path skips the current-password check above.
 */
export function canResetOtherPassword(
  actorId: string,
  targetId: string,
  newPassword: string,
): GuardResult {
  if (actorId === targetId) {
    return {
      ok: false,
      error: "Use the change-password form for your own account — it verifies your current password.",
    };
  }
  if (!validPlatformPassword(newPassword)) {
    return {
      ok: false,
      error: "New password must be at least 12 characters and contain both letters and numbers.",
    };
  }
  return OK;
}

/** Normalise and validate an email for a new admin. Returns null when unusable. */
export function normalisePlatformEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  // Deliberately loose: the authoritative check is that a real person receives
  // mail there. This only rejects obvious rubbish that would break the unique index.
  if (!email || email.length > 320 || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) return null;
  return email;
}
