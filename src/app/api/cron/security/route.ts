import { NextRequest, NextResponse } from "next/server";
import { runSecurityChecks } from "@/lib/securityRunbook";
import { sendPushToAll } from "@/lib/push";
import { getSetting } from "@/lib/settings";

export const maxDuration = 60;

/** Monthly security runbook (Vercel cron). Same auth pattern as the others. */
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const viaCronSecret = Boolean(cronSecret) && authHeader === `Bearer ${cronSecret}`;
  const apiKey = await getSetting("INTAKE_API_KEY");
  const provided = req.nextUrl.searchParams.get("key") ?? req.headers.get("x-api-key");
  const viaApiKey = Boolean(apiKey) && provided === apiKey;
  if (!viaCronSecret && !viaApiKey) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const run = await runSecurityChecks();
  const summary =
    run.failed > 0
      ? `❌ ${run.failed} failed, ${run.warned} warnings — score ${run.score}%`
      : run.warned > 0
        ? `⚠️ ${run.warned} warnings — score ${run.score}%`
        : `✅ All checks passed — score ${run.score}%`;

  await sendPushToAll(
    { title: "🛡️ Monthly security check", body: summary, url: "/settings/security" },
    "security"
  ).catch(() => {});

  return NextResponse.json({ ok: true, score: run.score, failed: run.failed, warned: run.warned });
}
