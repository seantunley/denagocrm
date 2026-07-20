import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { getEnabledModuleIds } from "@/lib/modules/enabled";
import { logError } from "@/lib/errorLog";
import { runJourneyEngine } from "@/lib/journeys";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Journeys belong to the marketing pack; don't run the engine when it's off.
  if (!(await getEnabledModuleIds()).has("marketing")) {
    return NextResponse.json({ ok: true, skipped: "marketing-disabled" });
  }

  try {
    return NextResponse.json({ ok: true, ...(await runJourneyEngine()) });
  } catch (error) {
    await logError("journey-engine", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Journey processing failed" },
      { status: 500 }
    );
  }
}
