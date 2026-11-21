import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getActiveTenantId, requireTenantOwner } from "@/lib/auth";
import { connectMetaPage, finishMetaConnect } from "@/lib/metaConnect";
import { logAudit } from "@/lib/audit";
import { logError } from "@/lib/errorLog";

/**
 * Connect Facebook, step 3 — back on the domain the owner started from, behind their own session. The state must
 * match the cookie set there at step 1 (the same browser) and be this workspace's, unexpired, and unused. One Page:
 * connected at once. Several: the owner picks in Settings. None: said so.
 */
export async function GET(request: Request) {
  const user = await requireTenantOwner();
  const url = new URL(request.url);
  const back = (outcome: string) => NextResponse.redirect(new URL(`/settings/integrations?meta=${outcome}`, request.url));
  const jar = await cookies();
  const cookieState = jar.get("meta_oauth")?.value;
  jar.delete({ name: "meta_oauth", path: "/api/integrations/meta" });
  const state = url.searchParams.get("state") ?? "";
  const tenantId = await getActiveTenantId();
  if (!tenantId || !cookieState || cookieState !== state) return back("invalid");
  if (url.searchParams.get("error") || !url.searchParams.get("code")) return back("denied");
  try {
    const pages = await finishMetaConnect({ tenantId, state, code: url.searchParams.get("code")! });
    if (pages.length === 0) return back("no-pages");
    if (pages.length > 1) return back("pick");
    const name = await connectMetaPage({ tenantId, pageId: pages[0].id });
    await logAudit({ action: "integration.meta_connected", summary: `Connected the Facebook Page "${name}"`, user });
    return back("connected");
  } catch (error) {
    // Meta's reason only — never a token or a code.
    await logError("meta-connect", error instanceof Error ? error.message : "unknown").catch(() => {});
    return back(error instanceof Error && /another workspace/.test(error.message) ? "in-use" : "failed");
  }
}
