import crypto from "crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getActiveTenantId, requireTenantOwner } from "@/lib/auth";
import { resolveIntegrationField } from "@/lib/settings";
import { threadsAuthorizeUrl } from "@/lib/threads";

/** Connect Threads (2026-11-21): the workspace's own owner, its own Threads app; a state cookie names the workspace. */
export async function GET(request: Request) {
  await requireTenantOwner();
  const tenantId = await getActiveTenantId();
  if (!tenantId) return NextResponse.json({ error: "No active workspace." }, { status: 403 });
  const clientId = await resolveIntegrationField(tenantId, "threads", "THREADS_APP_ID");
  if (!clientId) return NextResponse.redirect(new URL("/settings/integrations?threads=missing-app", request.url));
  const state = crypto.randomBytes(24).toString("base64url");
  const jar = await cookies();
  jar.set("threads_oauth", JSON.stringify({ state, tenantId }), { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/" });
  const redirectUri = new URL("/api/integrations/threads/callback", request.url).toString();
  return NextResponse.redirect(threadsAuthorizeUrl(clientId, redirectUri, state));
}
