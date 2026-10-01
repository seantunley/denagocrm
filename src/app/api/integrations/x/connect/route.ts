import crypto from "crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getActiveTenantId, requireTenantOwner } from "@/lib/auth";
import { resolveTenantCredential } from "@/lib/settings";

export async function GET(request: Request) {
  // The workspace's own owner, as on the Integrations page that offers this
  // button — the platform-owner-only guard here let no one else finish (review of #742).
  // Everything below is bound to the ACTIVE workspace: its client id, and a state
  // cookie naming it that the callback checks before writing anything.
  await requireTenantOwner();
  const tenantId = await getActiveTenantId();
  if (!tenantId) return NextResponse.json({ error: "No active workspace." }, { status: 403 });
  const clientId = await resolveTenantCredential(tenantId, "X_CLIENT_ID");
  if (!clientId) return NextResponse.redirect(new URL("/settings/integrations?x=missing-client", request.url));
  const state = crypto.randomBytes(24).toString("base64url");
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const jar = await cookies();
  jar.set("x_oauth", JSON.stringify({ state, verifier, tenantId }), { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/" });
  const redirectUri = new URL("/api/integrations/x/callback", request.url).toString();
  const authorize = new URL("https://twitter.com/i/oauth2/authorize");
  authorize.search = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri,
    scope: "tweet.read users.read dm.read dm.write offline.access",
    state, code_challenge: challenge, code_challenge_method: "S256",
  }).toString();
  return NextResponse.redirect(authorize);
}
