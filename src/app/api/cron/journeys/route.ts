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
    const runs = await runCronPerTenant(async () => {
      const enabled = await getEnabledModuleIds();
      if (!enabled.has("automation") && !enabled.has("marketing")) {
        return { skipped: "automation-and-marketing-disabled" as const };
      }
      return runJourneyEngine();
    }, {
      maxRuntimeMs: 50_000,
      minStartBudgetMs: 8_000,
      concurrency: 2,
      rotationWindowMs: 15 * 60 * 1000,
      onError: (tenantId, error) => logError(`journey-engine:${tenantId}`, error),
    });
    const dormant = runs.length === 1 && runs[0].tenantId === null ? runs[0] : null;
    if (dormant?.status === "ok") return NextResponse.json({ ok: true, ...dormant.result });
    return NextResponse.json({ ok: true, tenants: runs });
  } catch (error) {
    await logError("journey-engine", error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Journey processing failed" }, { status: 500 });
  }
}
