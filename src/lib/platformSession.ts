import { SignJWT, jwtVerify } from "jose";

/**
 * Session primitives for the PLATFORM console — deliberately separate from the
 * CRM's `session.ts`, not a parameterisation of it.
 *
 * Why a second implementation rather than a shared one:
 *   - DIFFERENT COOKIE, DIFFERENT PATH. The cookie is named separately and scoped
 *     to `/platform`, so the browser never sends it to CRM routes and a CRM XSS
 *     cannot read it. A shared helper with a `path` argument invites a caller to
 *     accidentally widen it back to "/".
 *   - DIFFERENT AUDIENCE CLAIM. Tokens carry `aud: "platform"` and are rejected
 *     if that claim is absent, so a CRM session token can never be replayed
 *     against the console even though both are signed with SESSION_SECRET.
 *   - DIFFERENT LIFETIME POLICY. No PWA / "remember me" extension: a cross-tenant
 *     super-admin session is short-lived by design.
 *
 * The signing secret IS shared (SESSION_SECRET) — the separation that matters is
 * the audience claim and the cookie scope, not key material. If you later want
 * independent key rotation, add PLATFORM_SESSION_SECRET and fall back to
 * SESSION_SECRET only when it is unset.
 */

const secret = () => {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SESSION_SECRET is not set (or too short) in production.");
    }
    return new TextEncoder().encode("dev-secret-local-only");
  }
  return new TextEncoder().encode(s);
};

/** Audience claim marking a token as a platform-console session. */
const PLATFORM_AUDIENCE = "platform";

/**
 * Hard re-login cap. Shorter than the CRM's 72h: this session can create and
 * suspend tenants, so it should not sit around for days.
 */
export const PLATFORM_ABSOLUTE_HOURS = 12;
/** Inactivity timeout, in minutes. */
export const PLATFORM_IDLE_MINUTES = 30;

export const PLATFORM_SESSION_COOKIE = "denago_platform_session";

export type PlatformSessionPayload = {
  /** Session-registry id — the server-side half, for remote revocation. */
  jti: string;
  /** PlatformAdmin id. */
  sub: string;
  name: string;
  email: string;
  /** Database session version; incrementing it revokes every older session. */
  sv: number;
  /** Idle timeout in minutes. */
  idle: number;
  /** Last-active unix seconds. */
  la: number;
  /** Absolute expiry, unix seconds. */
  abs: number;
};

export async function signPlatformSession(
  admin: { id: string; name: string; email: string; sessionVersion: number },
  jti: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signWith({
    jti,
    sub: admin.id,
    name: admin.name,
    email: admin.email,
    sv: admin.sessionVersion,
    idle: PLATFORM_IDLE_MINUTES,
    la: now,
    abs: now + PLATFORM_ABSOLUTE_HOURS * 3600,
  });
}

/** Re-stamp `la` so an active admin isn't logged out by the idle timeout. */
export async function refreshPlatformSession(
  payload: PlatformSessionPayload,
): Promise<string> {
  return signWith({ ...payload, la: Math.floor(Date.now() / 1000) });
}

async function signWith(payload: PlatformSessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(PLATFORM_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(payload.abs)
    .sign(secret());
}

export type PlatformVerifyResult =
  | { status: "ok"; payload: PlatformSessionPayload; needsRefresh: boolean }
  | { status: "expired" }
  | { status: "invalid" };

export async function verifyPlatformSessionFull(
  token: string,
): Promise<PlatformVerifyResult> {
  try {
    // `audience` is enforced by jwtVerify — a CRM token (no `aud`) throws here,
    // so console access can never be obtained with a CRM session cookie.
    const { payload } = await jwtVerify(token, secret(), {
      audience: PLATFORM_AUDIENCE,
    });
    if (
      typeof payload.sub !== "string" ||
      typeof payload.jti !== "string" ||
      typeof payload.la !== "number" ||
      typeof payload.sv !== "number"
    ) {
      return { status: "invalid" };
    }
    const p = payload as unknown as PlatformSessionPayload;
    const now = Math.floor(Date.now() / 1000);
    if (p.idle && now - p.la > p.idle * 60) return { status: "expired" };
    return { status: "ok", payload: p, needsRefresh: now - p.la > 120 };
  } catch {
    return { status: "expired" };
  }
}

export async function verifyPlatformSession(
  token: string,
): Promise<PlatformSessionPayload | null> {
  const result = await verifyPlatformSessionFull(token);
  return result.status === "ok" ? result.payload : null;
}

/**
 * Cookie options for a platform session. `path` is "/platform" so the browser
 * never attaches this cookie to CRM requests — the console's credential and the
 * CRM's are not merely different values, they travel on different paths.
 */
export function platformCookieOptions() {
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/platform",
    maxAge: PLATFORM_ABSOLUTE_HOURS * 3600,
  };
}
