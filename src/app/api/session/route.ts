import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * "Am I still signed in?" for SessionKeeper. Passing through the proxy is also
 * what slides the idle window, so a person actively working in a form is never
 * timed out underneath it. 204 when the session is good, 401 when it isn't.
 */
export async function GET() {
  try {
    await requireApiUser();
  } catch {
    return new NextResponse(null, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
