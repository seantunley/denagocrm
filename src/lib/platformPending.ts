import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

/**
 * The half-authenticated state between a correct platform password and a correct
 * second factor.
 *
 * A SEPARATE cookie from the CRM's `denago_2fa_pending`, and separate on
 * purpose. The two logins authenticate different identity tables — PlatformAdmin
 * and User — and a shared cookie name would let a pending CRM login be finished
 * at the platform's verify step, or the reverse, depending only on which action
 * read it first. The whole point of the console having its own identity is that
 * console access is not derived from anything about a CRM account.
 *
 * ── What is in it, and what is deliberately not ─────────────────────────────
 *
 * The admin's id and the session version it was issued against — nothing else.
 * Not their name, not their email, not whether they have backup codes left: this
 * cookie is held by someone who has proved only a password, and every field it
 * carries is a field they can read. The verify step re-reads the admin row from
 * the database anyway, so anything cached here would be a second copy that could
 * be stale AND disclosive.
 *
 * The session version is the exception, and it is there to be COMPARED rather
 * than trusted. Without it, "revoke all sessions" and a password reset both left
 * a half-finished login sitting in somebody's browser, still able to complete
 * for the rest of the ten-minute window — so the one action taken when an
 * account is believed compromised did not actually stop the login in progress.
 *
 * Ten minutes, matching the CRM's window. Long enough to open an authenticator
 * app and find the entry, short enough that a machine left unattended between
 * the two steps is not a standing invitation.
 *
 * Signed with SESSION_SECRET so it cannot be forged into "this password was
 * already checked for admin X" — which is exactly what it asserts.
 */
const PENDING_COOKIE = "denago_platform_2fa_pending";
const TTL_SECONDS = 600;

function secret(): Uint8Array {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 16) {
    // Production must never fall through to a known key: the cookie asserts that
    // a password check already passed, so a guessable signing key turns the
    // second factor into the ONLY factor for anyone who can set a cookie.
    if (process.env.NODE_ENV === "production") {
      throw new Error("SESSION_SECRET is not set (or too short) in production.");
    }
    return new TextEncoder().encode("dev-secret-local-only");
  }
  return new TextEncoder().encode(value);
}

export async function issuePlatformPending(adminId: string, sessionVersion: number): Promise<void> {
  const token = await new SignJWT({ pid: adminId, sv: sessionVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(secret());
  const store = await cookies();
  store.set(PENDING_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: TTL_SECONDS,
  });
}

export type PlatformPending = { adminId: string; sessionVersion: number };

export async function readPlatformPending(): Promise<PlatformPending | null> {
  const store = await cookies();
  const token = store.get(PENDING_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    if (typeof payload.pid !== "string" || typeof payload.sv !== "number") return null;
    return { adminId: payload.pid, sessionVersion: payload.sv };
  } catch {
    return null;
  }
}

/**
 * Cleared on SUCCESS, and on giving up — never left to expire on its own.
 *
 * A spent pending cookie is a password check somebody else can finish if they
 * reach the same browser within ten minutes.
 */
export async function clearPlatformPending(): Promise<void> {
  const store = await cookies();
  store.delete(PENDING_COOKIE);
}
