import crypto from "crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getActiveTenantId, requireTenantOwner } from "@/lib/auth";
import { resolveIntegrationField } from "@/lib/settings";
import { XERO_SCOPES } from "@/lib/xero";

/**
 * "Connect Xero" — sends the workspace owner to Xero's consent screen. Same shape
 * as X's connect route: owner only, bound to the ACTIVE workspace, with a state
 * cookie naming it that the callback checks before writing anything.
 */
export async function GET(request: Request) {
  await requireTenantOwner();
  const tenantId = await getActiveTenantId();
  if (!tenantId) return NextResponse.json({ error: "No active workspace." }, { status: 403 });
  const clientId = await resolveIntegrationField(tenantId, "xero", "XERO_CLIENT_ID");
  if (!clientId) return NextResponse.redirect(new URL("/settings/integrations?xero=missing-client", request.url));
  const state = crypto.randomBytes(24).toString("base64url");
  const jar = await cookies();
  jar.set("xero_oauth", JSON.stringify({ state, tenantId }), { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/" });
  const authorize = new URL("https://login.xero.com/identity/connect/authorize");
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: new URL("/api/integrations/xero/callback", request.url).toString(),
    scope: XERO_SCOPES,
    state,
  }).toString();
  return NextResponse.redirect(authorize);
}
