import { cookies, headers } from "next/headers";
import crypto from "crypto";
import { redirect } from "next/navigation";
import { prisma } from "./db";
import { getSetting } from "./settings";
import { hasModule, type ModuleId } from "./access";
import { getUserSecurityState } from "./userSecurity";
import {
  verifySession,
  signFreshSession,
  SESSION_COOKIE,
  sessionCookieOptions,
  DEFAULT_IDLE_MINUTES,
} from "./session";

export async function getCurrentUser() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await verifySession(token);
  if (!session) return null;
  // Session registry: revoked devices are locked out on their next request.
  if (session.jti) {
    const row = await prisma.userSession.findUnique({
      where: { jti: session.jti },
      select: { revokedAt: true, lastActiveAt: true },
    });
    if (!row || row.revokedAt) return null;
    if (Date.now() - row.lastActiveAt.getTime() > 10 * 60 * 1000) {
      void prisma.userSession
        .update({ where: { jti: session.jti }, data: { lastActiveAt: new Date() } })
        .catch(() => {});
    }
  }

  // Governance: disabled accounts and stale session versions are rejected on
  // every request, so permission/role/password changes take effect immediately.
  const [user, security] = await Promise.all([
    prisma.user.findUnique({ where: { id: session.sub } }),
    getUserSecurityState(session.sub),
  ]);
  if (!user || !security || security.disabledAt) return null;
  if (security.sessionVersion !== session.sv) return null;
  return user;
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireOwner() {
  const user = await requireUser();
  if (user.role !== "owner") redirect("/");
  return user;
}

export async function requireAnyModule(...mods: ModuleId[]) {
  const user = await requireUser();
  if (user.role === "owner") return user;
  if (!mods.some((module) => hasModule(user, module))) redirect("/");
  return user;
}

export const requireCrm = () => requireAnyModule("crm");
export const requireWorkshop = () => requireAnyModule("workshop");
export const requireCrmOrWorkshop = () => requireAnyModule("crm", "workshop");
export const requireInbox = () => requireAnyModule("inbox");
export const requireOperational = () => requireAnyModule("crm", "workshop", "inbox");

export async function getIdleMinutes(): Promise<number> {
  const raw = await getSetting("SESSION_IDLE_MINUTES");
  const n = raw ? parseInt(raw, 10) : DEFAULT_IDLE_MINUTES;
  return isNaN(n) || n < 5 ? DEFAULT_IDLE_MINUTES : n;
}

export async function createSessionCookie(
  user: { id: string; name: string; email: string; role: string; modules: string },
  opts?: { pwa?: boolean }
) {
  const security = await getUserSecurityState(user.id);
  if (!security || security.disabledAt) throw new Error("User is disabled or no longer exists");
  const pwa = Boolean(opts?.pwa);
  // Installed PWA: the phone lock is the security boundary — a flat 7-day
  // session keeps push notifications alive. Desktop keeps the configured idle.
  const idle = pwa ? 7 * 24 * 60 : await getIdleMinutes();
  const jti = crypto.randomUUID();
  const h = await headers();
  await prisma.userSession.create({
    data: {
      jti,
      userId: user.id,
      platform: pwa ? "pwa" : "web",
      ip: (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || null,
      userAgent: (h.get("user-agent") ?? "").slice(0, 250) || null,
    },
  });
  const token = await signFreshSession(
    { ...user, sessionVersion: security.sessionVersion },
    idle,
    { jti, pwa }
  );
  const store = await cookies();
  store.set(SESSION_COOKIE, token, sessionCookieOptions);
}

export async function destroySessionCookie() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
