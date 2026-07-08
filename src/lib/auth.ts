import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "./db";
import { getSetting } from "./settings";
import { hasModule, type ModuleId } from "./access";
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
  const user = await prisma.user.findUnique({ where: { id: session.sub } });
  return user;
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** Owner-only guard for user management and security policy. */
export async function requireOwner() {
  const user = await requireUser();
  if (user.role !== "owner") redirect("/");
  return user;
}

/**
 * Module guard for server actions. Route gating in proxy.ts only covers page
 * navigation; server actions dispatch by header regardless of URL, so each
 * action must re-check the caller's modules server-side. Owners always pass.
 * Soft-bounces to "/" (matching the route gate) rather than throwing.
 */
export async function requireAnyModule(...mods: ModuleId[]) {
  const user = await requireUser();
  if (user.role === "owner") return user;
  if (!mods.some((m) => hasModule(user, m))) redirect("/");
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
  const idle = await getIdleMinutes();
  const token = await signFreshSession(user, idle);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, sessionCookieOptions);
}

export async function destroySessionCookie() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
