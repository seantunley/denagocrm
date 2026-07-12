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
export const PWA_SESSION_HOURS = 7 * 24; // installed-app sessions last a week
export const DEFAULT_IDLE_MINUTES = 60;

export type SessionPayload = {
  jti?: string; // session-registry id (device log / remote sign-out)
  pwa?: boolean; // installed app — 7-day session, device lock is the boundary
  sub: string;
  name: string;
  email: string;
  role: string;
  mods: string;
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
    modules: string;
    sessionVersion: number;
  },
  idleMinutes: number,
  opts?: { jti?: string; pwa?: boolean }
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const abs = now + (opts?.pwa ? PWA_SESSION_HOURS : ABSOLUTE_SESSION_HOURS) * 3600;
  return signWith({
    ...(opts?.jti ? { jti: opts.jti } : {}),
    ...(opts?.pwa ? { pwa: true } : {}),
    sub: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    mods: user.modules,
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

export const sessionCookieOptions = {
  httpOnly: true as const,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: ABSOLUTE_SESSION_HOURS * 3600,
};
