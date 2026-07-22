import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { getEnabledModuleIds } from "@/lib/modules/enabled";
import { logError } from "@/lib/errorLog";
import { runJourneyEngine } from "@/lib/journeys";
import { runCronPerTenant } from "@/lib/tenantCron";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    // Journeys are a per-tenant business queue. DORMANT → one global run
    // (unchanged). ENFORCING → one run per active tenant, each in its own scope,
    // so the module gate + engine read only that tenant's data. The marketing
    // gate stays inside the slice so it's evaluated per tenant under enforcement.
    const runs = await runCronPerTenant(async () => {
      if (!(await getEnabledModuleIds()).has("marketing")) {
        return { skipped: "marketing-disabled" as const };
      }
      return runJourneyEngine();
    });
    if (runs.length === 1 && runs[0].tenantId === null) {
      return NextResponse.json({ ok: true, ...runs[0].result });
    }
    return NextResponse.json({ ok: true, tenants: runs });
  } catch (error) {
    await logError("journey-engine", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Journey processing failed" },
      { status: 500 }
    );
  }
}
