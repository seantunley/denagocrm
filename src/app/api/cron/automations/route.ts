import { NextRequest, NextResponse } from "next/server";
import { runIdleAutomations } from "@/lib/automations";
import { getSetting } from "@/lib/settings";

/**
 * Runs idle-lead automation rules. Call periodically (cron, uptime monitor):
 *   GET /api/cron/automations?key=<INTAKE_API_KEY>
 * The dashboard also runs these opportunistically on load.
 */
export async function GET(req: NextRequest) {
  const apiKey = await getSetting("INTAKE_API_KEY");
  const provided =
    req.nextUrl.searchParams.get("key") ?? req.headers.get("x-api-key");
  if (!apiKey || provided !== apiKey) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 401 });
  }
  const fired = await runIdleAutomations();
  return NextResponse.json({ ok: true, fired });
}
