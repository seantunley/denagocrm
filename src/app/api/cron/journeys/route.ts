import { NextRequest, NextResponse } from "next/server";
import { getSetting } from "@/lib/settings";
import { logError } from "@/lib/errorLog";
import { runJourneyEngine } from "@/lib/journeys";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const viaCron = Boolean(cronSecret) && req.headers.get("authorization") === `Bearer ${cronSecret}`;
  const manualKey = await getSetting("INTAKE_API_KEY");
  const supplied = req.nextUrl.searchParams.get("key") ?? req.headers.get("x-api-key");
  const viaManual = Boolean(manualKey) && supplied === manualKey;
  if (!viaCron && !viaManual) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
