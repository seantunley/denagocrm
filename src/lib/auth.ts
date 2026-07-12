import { cookies } from "next/headers";
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

export async function createSessionCookie(user: {
  id: string;
  name: string;
  email: string;
  role: string;
  modules: string;
}) {
  const security = await getUserSecurityState(user.id);
  if (!security || security.disabledAt) throw new Error("User is disabled or no longer exists");
  const idle = await getIdleMinutes();
  const token = await signFreshSession(
    { ...user, sessionVersion: security.sessionVersion },
    idle
  );
  const store = await cookies();
  store.set(SESSION_COOKIE, token, sessionCookieOptions);
}

export async function destroySessionCookie() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
