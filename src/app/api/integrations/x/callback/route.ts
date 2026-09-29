import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getActiveTenantId, requireOwner } from "@/lib/auth";
import { exchangeXCode } from "@/lib/x";

export async function GET(request: Request) {
  await requireOwner();
  const url = new URL(request.url);
  const jar = await cookies();
  const raw = jar.get("x_oauth")?.value;
  jar.delete("x_oauth");
  if (!raw || !url.searchParams.get("code")) return NextResponse.redirect(new URL("/settings?tab=integrations&x=denied", request.url));
  let pending: { state: string; verifier: string; tenantId: string };
  try { pending = JSON.parse(raw); } catch { return NextResponse.redirect(new URL("/settings?tab=integrations&x=invalid", request.url)); }
  const activeTenantId = await getActiveTenantId();
  if (!activeTenantId || activeTenantId !== pending.tenantId || url.searchParams.get("state") !== pending.state) {
    return NextResponse.json({ error: "Invalid X OAuth state." }, { status: 403 });
  }
  const redirectUri = new URL("/api/integrations/x/callback", request.url).toString();
  await exchangeXCode({ tenantId: activeTenantId, code: url.searchParams.get("code")!, verifier: pending.verifier, redirectUri });
  return NextResponse.redirect(new URL("/settings?tab=integrations&x=connected", request.url));
}
