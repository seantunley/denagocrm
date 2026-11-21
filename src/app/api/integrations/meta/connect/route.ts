import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getActiveTenantId, requireTenantOwner } from "@/lib/auth";
import { connectOriginAllowed, startMetaConnect } from "@/lib/metaConnect";

/**
 * Connect Facebook, step 1 (lib/metaConnect.ts) — on the domain the owner is using, white-label or the platform's. The
 * one-time state is stored server-side with this origin, and set as a cookie HERE, so /finish (back on this domain)
 * can prove the same browser started it.
 */
export async function GET(request: Request) {
  const user = await requireTenantOwner();
  const tenantId = await getActiveTenantId();
  if (!tenantId) return NextResponse.json({ error: "No active workspace." }, { status: 403 });
  const origin = new URL(request.url).origin;
  if (!(await connectOriginAllowed(tenantId, origin))) return NextResponse.json({ error: "Open Settings from your workspace's own address and try again." }, { status: 400 });
  const started = await startMetaConnect({ tenantId, userId: user.id, origin });
  if (!started) return NextResponse.redirect(new URL("/settings/integrations?meta=missing-app", request.url));
  const jar = await cookies();
  jar.set("meta_oauth", started.state, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/api/integrations/meta" });
  return NextResponse.redirect(started.url);
}
