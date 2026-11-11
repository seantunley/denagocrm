import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getActiveTenantId, requireTenantOwner } from "@/lib/auth";
import { XeroAmbiguousOrganisation, exchangeXeroCode } from "@/lib/xero";
import { logAudit } from "@/lib/audit";
import { logError } from "@/lib/errorLog";

/**
 * Xero sends the owner back here. The state cookie must name the workspace that
 * started the connect, and only that workspace's credential rows are written.
 */
export async function GET(request: Request) {
  const user = await requireTenantOwner();
  const url = new URL(request.url);
  const back = (outcome: string) => NextResponse.redirect(new URL(`/settings/integrations?xero=${outcome}`, request.url));
  const jar = await cookies();
  const raw = jar.get("xero_oauth")?.value;
  jar.delete("xero_oauth");
  if (!raw || !url.searchParams.get("code")) return back("denied");
  let pending: { state: string; tenantId: string };
  try { pending = JSON.parse(raw); } catch { return back("invalid"); }
  const activeTenantId = await getActiveTenantId();
  if (!activeTenantId || activeTenantId !== pending.tenantId || url.searchParams.get("state") !== pending.state) {
    return NextResponse.json({ error: "Invalid Xero OAuth state." }, { status: 403 });
  }
  try {
    const orgName = await exchangeXeroCode({
      tenantId: activeTenantId,
      code: url.searchParams.get("code")!,
      redirectUri: new URL("/api/integrations/xero/callback", request.url).toString(),
    });
    await logAudit({ action: "integration.xero_connected", summary: `Connected Xero organisation “${orgName}”`, user });
    return back("connected");
  } catch (err) {
    if (err instanceof XeroAmbiguousOrganisation) return back("ambiguous");
    await logError("xero-connect", err);
    return back("failed");
  }
}
