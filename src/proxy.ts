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
  "/api/track", // campaign open/click tracking
  "/api/unsubscribe", // one-click marketing unsubscribe
  "/portal", // customer portal has its own OTP session
  "/api/portal", // portal document/upload routes self-check the portal session
  "/s", // public survey response pages (token-gated)
  "/manifest.webmanifest",
  "/icons",
  "/sw.js",
  "/robots.txt",
];

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
    const res = NextResponse.next();
    res.cookies.set(SESSION_COOKIE, fresh, sessionCookieOptions);
    return res;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|ico)$).*)"],
};
