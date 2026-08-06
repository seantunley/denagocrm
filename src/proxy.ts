import { NextRequest, NextResponse } from "next/server";
import { routeAllowed } from "@/lib/routeAccess";
import {
  verifySessionFull,
  refreshSession,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/session";
import { buildCsp, buildCspReportOnly, buildPublicSigningCsp, newCspNonce } from "@/lib/csp";

const PUBLIC_PATHS = [
  "/login",
  "/api/auth/passkey/auth",
  "/api/webhooks",
  "/api/intake",
  "/api/cron",
  "/api/bookings",
  "/api/service-lookup",
  "/sign",
  "/api/sign",
  "/signing",
  "/api/signing",
  "/approvals",
  "/api/approvals",
  "/api/track",
  "/api/unsubscribe",
  "/portal",
  "/api/portal",
  "/platform",
  "/s",
  "/manifest.webmanifest",
  "/messages/manifest.webmanifest",
  "/icons",
  "/sw.js",
  "/robots.txt",
];

const SIGNING_TRUST_PATHS = ["/sign", "/api/sign", "/signing", "/api/signing", "/approvals", "/api/approvals"];
const pathMatches = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(prefix + "/");

function allow(req: NextRequest, csp: Csp): NextResponse {
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-pathname", req.nextUrl.pathname);
  requestHeaders.set("x-nonce", csp.nonce);
  requestHeaders.set("Content-Security-Policy", csp.value);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp.value);
  if (csp.reportOnly) res.headers.set("Content-Security-Policy-Report-Only", csp.reportOnly);
  return res;
}

function withCsp<T extends NextResponse>(res: T, csp: Csp): T {
  res.headers.set("Content-Security-Policy", csp.value);
  if (csp.reportOnly) res.headers.set("Content-Security-Policy-Report-Only", csp.reportOnly);
  return res;
}

type Csp = { nonce: string; value: string; reportOnly?: string };

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const nonce = newCspNonce();
  const dev = process.env.NODE_ENV === "development";
  const signingTrustSurface = SIGNING_TRUST_PATHS.some((prefix) => pathMatches(pathname, prefix));
  const csp: Csp = signingTrustSurface
    ? { nonce, value: buildPublicSigningCsp({ nonce, dev }) }
    : {
        nonce,
        value: buildCsp({ nonce, dev }),
        reportOnly: buildCspReportOnly({ nonce, dev }),
      };

  if (PUBLIC_PATHS.some((prefix) => pathMatches(pathname, prefix))) {
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
    if (result.status === "expired" && token) url.searchParams.set("timeout", "1");
    const res = withCsp(NextResponse.redirect(url), csp);
    res.cookies.delete(SESSION_COOKIE);
    return res;
  }

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

  if (result.needsRefresh) {
    const fresh = await refreshSession(result.payload);
    const res = allow(req, csp);
    res.cookies.set(SESSION_COOKIE, fresh, sessionCookieOptions(Boolean(result.payload.pwa)));
    return res;
  }

  return allow(req, csp);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|ico)$).*)"],
};
