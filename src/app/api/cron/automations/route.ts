import { NextRequest, NextResponse } from "next/server";
import { runIdleAutomations } from "@/lib/automations";
import { runServiceReminders } from "@/lib/serviceReminders";
import { getSetting } from "@/lib/settings";

/**
 * Runs idle-lead automation rules. Call periodically (cron, uptime monitor):
 *   GET /api/cron/automations?key=<INTAKE_API_KEY>
 * Vercel Cron authenticates via "Authorization: Bearer <CRON_SECRET>" instead.
 * The dashboard also runs these opportunistically on load.
 */
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const viaCronSecret =
    Boolean(cronSecret) && authHeader === `Bearer ${cronSecret}`;

  const apiKey = await getSetting("INTAKE_API_KEY");
  const provided =
    req.nextUrl.searchParams.get("key") ?? req.headers.get("x-api-key");
  const viaApiKey = Boolean(apiKey) && provided === apiKey;

  if (!viaCronSecret && !viaApiKey) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const fired = await runIdleAutomations();
  const remindersSent = await runServiceReminders().catch(() => -1);
  return NextResponse.json({ ok: true, fired, remindersSent });
}
