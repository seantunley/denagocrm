import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getActiveTenantId, requireTenantOwner } from "@/lib/auth";
import { exchangeThreadsCode } from "@/lib/threads";
import { logError } from "@/lib/errorLog";

/**
 * Connect Threads, the return leg (2026-11-21). Only the workspace that started it (state cookie), and
 * exchangeThreadsCode refuses a Threads account another workspace already holds before storing any token.
 */
export async function GET(request: Request) {
  await requireTenantOwner();
  const url = new URL(request.url);
  const jar = await cookies();
  const raw = jar.get("threads_oauth")?.value;
  jar.delete("threads_oauth");
  const back = (outcome: string) => NextResponse.redirect(new URL(`/settings/integrations?threads=${outcome}`, request.url));
  if (!raw || !url.searchParams.get("code")) return back("denied");
  let pending: { state: string; tenantId: string };
  try { pending = JSON.parse(raw); } catch { return back("invalid"); }
  const activeTenantId = await getActiveTenantId();
  if (!activeTenantId || activeTenantId !== pending.tenantId || url.searchParams.get("state") !== pending.state) {
    return NextResponse.json({ error: "Invalid Threads sign-in state." }, { status: 403 });
  }
  try {
    const redirectUri = new URL("/api/integrations/threads/callback", request.url).toString();
    await exchangeThreadsCode({ tenantId: activeTenantId, code: url.searchParams.get("code")!, redirectUri });
  } catch (error) {
    // The reason only — never a token or a code.
    await logError("threads-connect", error instanceof Error ? error.message : "unknown").catch(() => {});
    return back(error instanceof Error && /another workspace/.test(error.message) ? "in-use" : "failed");
  }
  return back("connected");
}
