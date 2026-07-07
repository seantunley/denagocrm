import { SignJWT, jwtVerify } from "jose";

const secret = () => {
  const s = process.env.SESSION_SECRET;
  // Never fall back to a known value in production — that would let anyone
  // forge a valid session cookie.
  if (!s || s.length < 16) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SESSION_SECRET is not set (or too short) in production.");
    }
    return new TextEncoder().encode("dev-secret-local-only");
  }
  return new TextEncoder().encode(s);
};

export const ABSOLUTE_SESSION_HOURS = 72; // hard re-login cap regardless of activity
export const DEFAULT_IDLE_MINUTES = 60;

export type SessionPayload = {
  sub: string;
  name: string;
  email: string;
  role: string;
  idle: number; // idle-timeout minutes baked in at login
  la: number; // last-active unix seconds
  abs: number; // absolute expiry unix seconds (login + 72h, never extended)
};

/** Issues a fresh session at login: 72h absolute cap, chosen idle window. */
export async function signFreshSession(
  user: { id: string; name: string; email: string; role: string },
  idleMinutes: number
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const abs = now + ABSOLUTE_SESSION_HOURS * 3600;
  return signWith({
    sub: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    idle: idleMinutes,
    la: now,
    abs,
  });
}

/** Re-signs an existing session with a refreshed last-active, same absolute cap. */
export async function refreshSession(payload: SessionPayload): Promise<string> {
  return signWith({ ...payload, la: Math.floor(Date.now() / 1000) });
}

async function signWith(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(payload.abs) // absolute cap; jose rejects once passed
    .sign(secret());
}

export type VerifyResult =
  | { status: "ok"; payload: SessionPayload; needsRefresh: boolean }
  | { status: "expired" }
  | { status: "invalid" };

/** Verifies a session, enforcing the idle timeout on top of the absolute cap. */
export async function verifySessionFull(token: string): Promise<VerifyResult> {
  try {
    const { payload } = await jwtVerify(token, secret());
    if (typeof payload.sub !== "string" || typeof payload.la !== "number") {
      return { status: "invalid" };
    }
    const p = payload as unknown as SessionPayload;
    const now = Math.floor(Date.now() / 1000);
    if (p.idle && now - p.la > p.idle * 60) return { status: "expired" }; // idle timeout
    return { status: "ok", payload: p, needsRefresh: now - p.la > 120 };
  } catch {
    return { status: "expired" }; // includes absolute-cap expiry
  }
}

/** Lightweight verify used by server components (no refresh concern). */
export async function verifySession(token: string): Promise<SessionPayload | null> {
  const r = await verifySessionFull(token);
  return r.status === "ok" ? r.payload : null;
}

export const SESSION_COOKIE = "denago_session";

export const sessionCookieOptions = {
  httpOnly: true as const,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: ABSOLUTE_SESSION_HOURS * 3600,
};
