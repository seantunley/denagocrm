import "server-only";

import { cache } from "react";
import { cookies, headers } from "next/headers";
import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { NotAuthenticated } from "./actionResult";
import { basePrisma } from "./db";
import {
  PLATFORM_SESSION_COOKIE,
  platformCookieOptions,
  refreshPlatformSession,
  signPlatformSession,
  verifyPlatformSessionFull,
} from "./platformSession";

/**
 * Authentication for the PLATFORM console — an identity boundary entirely
 * separate from the CRM's `auth.ts`.
 *
 * A PlatformAdmin is NOT a `User` and holds no `TenantMember` row, so console
 * access does not flow through any tenant. Three consequences worth stating:
 *   - Suspending ANY tenant (the founding one included) cannot lock the platform
 *     operator out, because their identity does not live inside a tenant.
 *   - A compromised CRM session grants nothing here: different cookie, different
 *     path, and the token's `aud` claim is checked (see platformSession.ts).
 *   - These reads use `basePrisma`, which bypasses the Prisma extension entirely.
 *     Both models are also listed in GLOBAL_MODELS, so the tenant guard would not
 *     scope them even through the extended client. No system-scope wrapper is
 *     needed. NOTE for the RLS step: once RLS goes to FORCE, this connection needs
 *     an explicit bypass role or the console goes blind.
 */

export type PlatformAdminPrincipal = {
  id: string;
  name: string;
  email: string;
};

/**
 * Resolve the signed-in platform admin, or null. Wrapped in React `cache()` so
 * the layout and page each calling it costs one lookup per request.
 *
 * Revocation is checked on EVERY request, not just at login:
 *   - the session row must exist and not be revoked (remote sign-out),
 *   - the admin must exist and not be disabled,
 *   - the token's `sv` must match the admin's current `sessionVersion`
 *     (bumping it invalidates every outstanding session at once).
 */
export const getCurrentPlatformAdmin = cache(
  async (): Promise<PlatformAdminPrincipal | null> => {
    const store = await cookies();
    const token = store.get(PLATFORM_SESSION_COOKIE)?.value;
    if (!token) return null;

    const result = await verifyPlatformSessionFull(token);
    if (result.status !== "ok") return null;
    const payload = result.payload;

    const session = await basePrisma.platformAdminSession.findUnique({
      where: { jti: payload.jti },
      select: { revokedAt: true, lastActiveAt: true },
    });
    if (!session || session.revokedAt) return null;

    // Throttle the write: one touch per 10 minutes is enough for a "last seen"
    // column and keeps every console request from issuing an UPDATE.
    if (Date.now() - session.lastActiveAt.getTime() > 10 * 60 * 1000) {
      void basePrisma.platformAdminSession
        .update({ where: { jti: payload.jti }, data: { lastActiveAt: new Date() } })
        .catch(() => {});
    }

    const admin = await basePrisma.platformAdmin.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        name: true,
        email: true,
        disabledAt: true,
        sessionVersion: true,
      },
    });
    if (!admin || admin.disabledAt) return null;
    if (admin.sessionVersion !== payload.sv) return null;

    return { id: admin.id, name: admin.name, email: admin.email };
  },
);

/**
 * Gate for platform pages. Redirects to the console's OWN login (never the CRM's)
 * so an unauthenticated visitor is not bounced into a tenant surface.
 */
export async function requirePlatformAdmin(): Promise<PlatformAdminPrincipal> {
  const admin = await getCurrentPlatformAdmin();
  if (!admin) redirect("/platform/login");
  return admin;
}

/**
 * Gate for platform SERVER ACTIONS. Throws rather than redirecting: Server Actions
 * are reachable by direct POST regardless of what any page rendered, so every
 * action re-checks authorisation itself and fails loudly when absent.
 */
export async function requirePlatformAdminAction(): Promise<PlatformAdminPrincipal> {
  const admin = await getCurrentPlatformAdmin();
  // NotAuthenticated, not a bare Error: asActionResult turns this into "Your
  // session has ended. Sign in again." A plain Error became the generic failure
  // toast, which told a signed-out admin to "try again" — the one thing that
  // could not work, on the one failure they could have fixed themselves.
  if (!admin) throw new NotAuthenticated("Not authorized: platform admin access required.");
  // Slide the idle window here rather than in the layout: a Server Action MAY set
  // cookies, a Server Component may not. Best-effort — never fail an action that
  // has already passed authorisation just because the refresh could not be written.
  await touchPlatformSession().catch(() => {});
  return admin;
}

/** Issue a session: register it server-side, then set the scoped cookie. */
export async function createPlatformSessionCookie(admin: {
  id: string;
  name: string;
  email: string;
  sessionVersion: number;
}): Promise<void> {
  const jti = randomUUID();
  const headerList = await headers();
  const ip =
    headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headerList.get("x-real-ip") ||
    null;

  await basePrisma.platformAdminSession.create({
    data: {
      jti,
      adminId: admin.id,
      ip,
      userAgent: headerList.get("user-agent")?.slice(0, 500) ?? null,
    },
  });

  const token = await signPlatformSession(admin, jti);
  const store = await cookies();
  store.set(PLATFORM_SESSION_COOKIE, token, platformCookieOptions());
}

/**
 * Sign out. Revokes the session row FIRST so the session dies even if the cookie
 * delete is lost (or the token was copied elsewhere), then clears the cookie.
 */
export async function destroyPlatformSessionCookie(): Promise<void> {
  const store = await cookies();
  const token = store.get(PLATFORM_SESSION_COOKIE)?.value;

  if (token) {
    const result = await verifyPlatformSessionFull(token);
    if (result.status === "ok") {
      // Same rule as the staff logout, and for the same reason: this doc comment
      // above already says the delete may be lost or the token copied elsewhere,
      // which makes revocation the actual protection rather than a tidy-up. A
      // swallowed failure here clears the cookie, shows "signed out", and leaves a
      // platform-admin token live until it expires — the highest-privilege session
      // in the product, failing open with nothing written down.
      //
      // Still fails open on purpose; no longer fails silently.
      await basePrisma.platformAdminSession
        .updateMany({
          where: { jti: result.payload.jti, revokedAt: null },
          data: { revokedAt: new Date() },
        })
        .catch(async (err) => {
          const { logError } = await import("./errorLog");
          await logError(
            "platform-logout",
            err,
            "Platform admin session revocation failed; the cookie was cleared anyway, so this token stays valid until it expires.",
            { tenantId: null },
          );
        });
    }
  }

  store.delete({ name: PLATFORM_SESSION_COOKIE, path: "/platform" });
}

/**
 * Slide the idle window for an active admin.
 *
 * MUST only be called from a Server Action or Route Handler. Next.js forbids
 * cookie mutation during Server Component rendering, so calling this from a layout
 * or page throws — the console layout deliberately does not. `requirePlatformAdminAction`
 * calls it instead, which covers every console mutation.
 */
export async function touchPlatformSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(PLATFORM_SESSION_COOKIE)?.value;
  if (!token) return;
  const result = await verifyPlatformSessionFull(token);
  if (result.status !== "ok" || !result.needsRefresh) return;
  const refreshed = await refreshPlatformSession(result.payload);
  store.set(PLATFORM_SESSION_COOKIE, refreshed, platformCookieOptions());
}
