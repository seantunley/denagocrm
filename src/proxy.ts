import { NextRequest, NextResponse } from "next/server";
import { routeAllowed } from "@/lib/access";
import {
  verifySessionFull,
  refreshSession,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/session";

// /api/cron authenticates itself with the intake API key
const PUBLIC_PATHS = [
  "/login",
  "/api/auth/passkey/auth", // passkey (WebAuthn) login options + verify — pre-session
  "/api/webhooks",
  "/api/intake",
  "/api/cron",
  "/api/bookings",
  "/api/service-lookup",
  "/sign",
  "/api/sign",
  "/signing", // e-signing hub: per-recipient tokenised public signing pages
  "/api/signing",
  "/approvals", // internal approval gates: tokenised approve/reject pages (email links)
  "/api/approvals",
  "/api/track", // campaign open/click tracking
  "/api/unsubscribe", // one-click marketing unsubscribe
  "/portal", // customer portal has its own OTP session
  "/api/portal", // portal document/upload routes self-check the portal session
  // Platform console — "public" to THIS proxy only, because it authenticates with
  // its OWN identity (PlatformAdmin) and its own cookie, not the CRM session this
  // proxy checks. Without this entry the proxy bounces /platform to the CRM /login,
  // making the console reachable only by holding a CRM session — precisely the
  // coupling the separate identity exists to remove. Not unprotected: /platform/login
  // is meant to be reachable signed-out, and every page under /platform/(console)
  // calls requirePlatformAdmin while every console server action re-checks via
  // requirePlatformAdminAction.
  "/platform",
  "/s", // public survey response pages (token-gated)
  "/manifest.webmanifest",
  "/messages/manifest.webmanifest", // Denago Messages PWA manifest (no app data)
  "/icons",
  "/sw.js",
  "/robots.txt",
];

// Forward the pathname to server components (the (app) layout reads it to block
// routes that belong to a disabled module — a check middleware can't do itself
// because the enabled-module set lives in the database).
function allow(req: NextRequest): NextResponse {
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-pathname", req.nextUrl.pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const result = token ? await verifySessionFull(token) : { status: "invalid" as const };

  if (result.status !== "ok") {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    // Signal an idle/absolute timeout so the login page can explain the sign-out
    if (result.status === "expired" && token) url.searchParams.set("timeout", "1");
    const res = NextResponse.redirect(url);
    res.cookies.delete(SESSION_COOKIE);
    return res;
  }

  // Module gating: users only reach the modules ticked on their account
  if (
    !routeAllowed(pathname, {
      role: result.payload.role ?? "member",
      modules: result.payload.mods ?? "",
    })
  ) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  // Roll the session's last-active forward on activity (idle window slides,
  // absolute 72h cap does not).
  if (result.needsRefresh) {
    const fresh = await refreshSession(result.payload);
    const res = allow(req);
    // Match the cookie lifetime to the token — PWA sessions get the 7-day maxAge,
    // otherwise a refresh would shrink an installed app's cookie back to 72h.
    res.cookies.set(SESSION_COOKIE, fresh, sessionCookieOptions(Boolean(result.payload.pwa)));
    return res;
  }

  return allow(req);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|ico)$).*)"],
};
