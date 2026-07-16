import { NextRequest, NextResponse } from "next/server";
import { runSecurityChecks } from "@/lib/securityRunbook";
import { sendPushToAll } from "@/lib/push";
import { isAuthorizedCron } from "@/lib/cronAuth";

export const maxDuration = 60;

/** Monthly security runbook (Vercel cron — CRON_SECRET via Authorization header). */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
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
