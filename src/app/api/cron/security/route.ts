import { NextRequest, NextResponse } from "next/server";
import { runSecurityChecks } from "@/lib/securityRunbook";
import { sendPushToAll } from "@/lib/push";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { withSystemScope } from "@/lib/tenantScopeEntry";

export const maxDuration = 60;

/** Monthly security runbook (Vercel cron — CRON_SECRET via Authorization header). */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // The runbook sweeps every tenant's config/data and the push notifies all
  // admins — a platform-global operation → trusted system scope (guard bypass;
  // push recipients resolve to everyone rather than fail closed). Dormant → a
  // bare call, unchanged from before.
  const run = await withSystemScope(async () => {
    const result = await runSecurityChecks();
    const summary =
      result.failed > 0
        ? `❌ ${result.failed} failed, ${result.warned} warnings — score ${result.score}%`
        : result.warned > 0
          ? `⚠️ ${result.warned} warnings — score ${result.score}%`
          : `✅ All checks passed — score ${result.score}%`;
    await sendPushToAll(
      { title: "🛡️ Monthly security check", body: summary, url: "/settings/security" },
      "security",
    ).catch(() => {});
    return result;
  });

  return NextResponse.json({ ok: true, score: run.score, failed: run.failed, warned: run.warned });
}
