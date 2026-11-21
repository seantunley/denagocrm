import { NextResponse } from "next/server";
import { appBaseUrl } from "@/lib/campaigns";
import { metaConnectReturnOrigin } from "@/lib/metaConnect";

/**
 * Connect Facebook, step 2 — Meta's one redirect URI, on the platform's address, with no session (the person may be
 * signed in only on their white-label domain). It connects NOTHING: it looks up where this sign-in started (stored
 * server-side against the one-time state — never taken from the URL) and forwards Meta's answer there, to /finish,
 * which checks that person's session and state cookie.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const origin = await metaConnectReturnOrigin(state);
  if (!origin) return NextResponse.redirect(new URL("/settings/integrations?meta=invalid", appBaseUrl()));
  const forward = new URL("/api/integrations/meta/finish", origin);
  for (const key of ["state", "code", "error"]) {
    const value = url.searchParams.get(key);
    if (value) forward.searchParams.set(key, value);
  }
  return NextResponse.redirect(forward);
}
