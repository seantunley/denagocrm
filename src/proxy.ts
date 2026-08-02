import { NextRequest, NextResponse } from "next/server";
import { routeAllowed } from "@/lib/routeAccess";
import {
  verifySessionFull,
  refreshSession,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/session";
import { buildCsp, buildCspReportOnly, newCspNonce } from "@/lib/csp";

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
//
// Also carries the CSP nonce. Next extracts it from the Content-Security-Policy
// REQUEST header during rendering and stamps it onto its own script tags, so
// that header is not redundant with the response one — without it the scripts
// go out un-nonced and the page is blocked by its own policy.
function allow(req: NextRequest, csp: Csp): NextResponse {
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-pathname", req.nextUrl.pathname);
  requestHeaders.set("x-nonce", csp.nonce);
  requestHeaders.set("Content-Security-Policy", csp.value);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp.value);
  // The resource directives ride along as report-only until a preview deploy
  // has exercised the weather widget, address autocomplete and library upload.
  res.headers.set("Content-Security-Policy-Report-Only", csp.reportOnly);
  return res;
}

/** CSP on a response that renders no React (redirects, JSON errors). */
function withCsp<T extends NextResponse>(res: T, csp: Csp): T {
  res.headers.set("Content-Security-Policy", csp.value);
  return res;
}

type Csp = { nonce: string; value: string; reportOnly: string };

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // A fresh nonce per request, before anything can return early — the public
  // signing and portal pages need it as much as the authenticated app does.
  const nonce = newCspNonce();
  const dev = process.env.NODE_ENV === "development";
  const csp: Csp = {
    nonce,
    value: buildCsp({ nonce, dev }),
    reportOnly: buildCspReportOnly({ nonce, dev }),
  };

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return allow(req, csp);
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const result = token ? await verifySessionFull(token) : { status: "invalid" as const };

  if (result.status !== "ok") {
    if (pathname.startsWith("/api/")) {
      return withCsp(NextResponse.json({ error: "Unauthorized" }, { status: 401 }), csp);
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    // Signal an idle/absolute timeout so the login page can explain the sign-out
    if (result.status === "expired" && token) url.searchParams.set("timeout", "1");
    const res = withCsp(NextResponse.redirect(url), csp);
    res.cookies.delete(SESSION_COOKIE);
    return res;
  }

  // Route gating from the SINGLE authorization table (src/lib/routeAccess.ts).
  // The edge has the JWT and no database, so it reads the `rg` grant claim that
  // was derived from RBAC when the session was minted — the same ROUTE_RULES the
  // page guards evaluate against live RBAC. This is an optimistic pre-filter, not
  // the boundary: every gated page re-checks with requireRoute/requireOwner.
  // A pre-`rg` token carries no grants and is denied (fail closed).
  if (
    !routeAllowed(pathname, {
      role: result.payload.role ?? "member",
      grants: result.payload.rg ?? "",
    })
  ) {
    if (pathname.startsWith("/api/")) {
      return withCsp(NextResponse.json({ error: "Forbidden" }, { status: 403 }), csp);
    }
    const url = req.nextUrl.clone();
    url.pathname = "/";
    return withCsp(NextResponse.redirect(url), csp);
  }

  // Roll the session's last-active forward on activity (idle window slides,
  // absolute 72h cap does not).
  if (result.needsRefresh) {
    const fresh = await refreshSession(result.payload);
    const res = allow(req, csp);
    // Match the cookie lifetime to the token — PWA sessions get the 7-day maxAge,
    // otherwise a refresh would shrink an installed app's cookie back to 72h.
    res.cookies.set(SESSION_COOKIE, fresh, sessionCookieOptions(Boolean(result.payload.pwa)));
    return res;
  }

  return allow(req, csp);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|ico)$).*)"],
};
