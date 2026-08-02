import { SignJWT, jwtVerify } from "jose";

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

export const ABSOLUTE_SESSION_HOURS = 72; // hard re-login cap regardless of activity
// POLICY (must match src/lib/auth.ts): when `pwa` is set, the session lasts a
// week — BOTH its absolute cap (here) AND its idle timeout (auth.ts sets idle to
// 7 days too) are extended. `pwa` is a client-supplied choice (the login UI sets
// it from the browser's installed display-mode, but a caller can submit pwa=1
// directly), so this is an opt-in "keep me signed in for a week" available to any
// authenticated user — NOT proof of a trusted device. The real boundary is
// server-side revocation (session version `sv` + per-session `jti` remote
// sign-out), never the flag itself. If a shorter inactivity window is wanted for
// this mode, keep the normal idle timeout in auth.ts and extend only this cap; if
// true device-trust is wanted, gate `pwa` on a server-recognised device.
export const PWA_SESSION_HOURS = 7 * 24; // opt-in weeklong ("remember me") session
export const DEFAULT_IDLE_MINUTES = 60;

export type SessionPayload = {
  jti?: string; // session-registry id (device log / remote sign-out)
  pwa?: boolean; // opt-in weeklong session (extends BOTH idle + absolute); see PWA_SESSION_HOURS
  tid?: string; // active tenant id (multi-tenancy plumbing) — carried, NOT yet enforced
  sub: string;
  name: string;
  email: string;
  role: string;
  /**
   * Route grants — the guarded prefixes this user's RBAC opened at sign-in, as a
   * CSV of ROUTE_RULES prefixes. DERIVED, never authored: see routeAccess.ts and
   * the mint site in auth.ts#createSessionCookie. It replaces the old `mods`
   * claim, which carried a hand-ticked per-user module CSV that RBAC neither
   * read nor wrote — the proxy and the page guards disagreed as a result.
   */
  rg: string;
  sv: number; // database session version; incrementing it revokes every older session
  idle: number;
  la: number;
  abs: number;
};

export async function signFreshSession(
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
    /** Derived from RBAC by the caller — see routeAccess.ts#routeGrants. */
    grants: string;
    sessionVersion: number;
  },
  idleMinutes: number,
  opts?: { jti?: string; pwa?: boolean; tid?: string }
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const abs = now + (opts?.pwa ? PWA_SESSION_HOURS : ABSOLUTE_SESSION_HOURS) * 3600;
  return signWith({
    ...(opts?.jti ? { jti: opts.jti } : {}),
    ...(opts?.pwa ? { pwa: true } : {}),
    ...(opts?.tid ? { tid: opts.tid } : {}),
    sub: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    rg: user.grants,
    sv: user.sessionVersion,
    idle: idleMinutes,
    la: now,
    abs,
  });
}

export async function refreshSession(payload: SessionPayload): Promise<string> {
  return signWith({ ...payload, la: Math.floor(Date.now() / 1000) });
}

async function signWith(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(payload.abs)
    .sign(secret());
}

export type VerifyResult =
  | { status: "ok"; payload: SessionPayload; needsRefresh: boolean }
  | { status: "expired" }
  | { status: "invalid" };

export async function verifySessionFull(token: string): Promise<VerifyResult> {
  try {
    const { payload } = await jwtVerify(token, secret());
    if (
      typeof payload.sub !== "string" ||
      typeof payload.la !== "number" ||
      typeof payload.sv !== "number"
    ) {
      return { status: "invalid" };
    }
    const p = payload as unknown as SessionPayload;
    const now = Math.floor(Date.now() / 1000);
    if (p.idle && now - p.la > p.idle * 60) return { status: "expired" };
    return { status: "ok", payload: p, needsRefresh: now - p.la > 120 };
  } catch {
    return { status: "expired" };
  }
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  const result = await verifySessionFull(token);
  return result.status === "ok" ? result.payload : null;
}

export const SESSION_COOKIE = "denago_session";

/**
 * Cookie options for a session. The cookie's maxAge MUST match the token's
 * absolute lifetime, or an installed PWA (7-day token) gets a cookie that the
 * browser drops after the desktop 72h cap — logging the app out after ~3 days
 * despite the token and comments promising a week. Pass `pwa` so the two agree.
 */
export function sessionCookieOptions(pwa = false) {
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: (pwa ? PWA_SESSION_HOURS : ABSOLUTE_SESSION_HOURS) * 3600,
  };
}
