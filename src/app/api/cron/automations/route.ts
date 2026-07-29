import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;
import { runIdleAutomations } from "@/lib/automations";
import { runServiceReminders } from "@/lib/serviceReminders";
import { runSignatureRequestReminders } from "@/lib/signingReminders";
import { recoverStaleSigningClaims } from "@/lib/signing/dispatch";
import { syncFacebookLeads } from "@/lib/metaLeadSync";
import { syncGoogleReviews } from "@/lib/googleReviews";
import { syncInboundEmail } from "@/lib/imapSync";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { getEnabledModuleIds } from "@/lib/modules/enabled";
import type { ModuleId } from "@/lib/modules/registry";
import { logError } from "@/lib/errorLog";
import { withDbRetry } from "@/lib/dbRetry";
import { runAutoResearch } from "@/lib/ai";
import { runActivityReminders } from "@/lib/activityReminders";
import { runSafeCampaignQueue } from "@/lib/marketingCampaignQueue";
import { runSafeSurveyDistributionQueue } from "@/lib/surveyDistributionQueue";
import { runLifecycleJourneys } from "@/lib/lifecycleJourneys";
import { runAiHealthIfDue, runBackupWatchdog } from "@/lib/systemHealth";
import { basePrisma } from "@/lib/db";
import { expireReservations } from "@/lib/stockPlatform";
import { resolveTenantActor } from "@/lib/tenantActor";
import { runCronPerTenant, type CronRun } from "@/lib/tenantCron";
import { withSystemScope } from "@/lib/tenantScopeEntry";

async function runOperationalQueues() {
  const enabled = await getEnabledModuleIds().catch(() => null);
  const on = (id: ModuleId) => enabled === null || enabled.has(id);

  const fired = await runIdleAutomations();
  const remindersSent = on("automotive")
    ? await runServiceReminders().catch((e) => { logError("service-reminders", e); return -1; })
    : null;
  const signingReminders = await runSignatureRequestReminders().catch((e) => {
    logError("signature-request-reminders", e);
    return -1;
  });
  const staleSigningClaims = await recoverStaleSigningClaims().catch((e) => { logError("stale-signing-claims", e); return null; });
  const fbLeads = on("marketing")
    ? await syncFacebookLeads().catch((e) => { logError("meta-lead-sync", e); return -1; })
    : null;
  const googleReviews = on("marketing")
    ? await syncGoogleReviews().catch((e) => { logError("google-reviews", e); return -1; })
    : null;
  const inboundEmail = await syncInboundEmail().catch((e) => { logError("imap-sync", e); return -1; });
  const activityReminders = await runActivityReminders().catch((e) => { logError("activity-reminders", e); return -1; });
  const aiResearch = await runAutoResearch().catch((e) => { logError("ai-auto-research", e); return -1; });
  const campaignSent = on("marketing")
    ? await runSafeCampaignQueue().catch((e) => { logError("campaign-queue", e); return -1; })
    : null;
  const surveyQueue = on("marketing")
    ? await runSafeSurveyDistributionQueue().catch((e) => { logError("survey-distribution-queue", e); return -1; })
    : null;
  const lifecycleSent = on("marketing")
    ? await runLifecycleJourneys().catch((e) => { logError("lifecycle-journeys", e); return -1; })
    : null;
  const stockActor = on("commerce")
    ? await resolveTenantActor({ ownerOnly: true })
    : null;
  const stockReservationsExpired = !on("commerce")
    ? null
    : stockActor
      ? await expireReservations(stockActor).catch((e) => { logError("stock-reservation-expiry", e); return -1; })
      : 0;
  return {
    fired,
    remindersSent,
    signingReminders,
    staleSigningClaims,
    fbLeads,
    googleReviews,
    inboundEmail,
    aiResearch,
    campaignSent,
    surveyQueue,
    lifecycleSent,
    activityReminders,
    stockReservationsExpired,
  };
}

type OperationalResult = Awaited<ReturnType<typeof runOperationalQueues>>;

async function runGlobalMaintenance() {
  await withSystemScope(async () => {
    await runAiHealthIfDue().catch((e) => logError("ai-health", e));
    await runBackupWatchdog().catch(() => {});
    await basePrisma.errorLog
      .deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } } })
      .catch(() => {});
  });
}

export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Leave room inside maxDuration (60s) for runGlobalMaintenance in the finally.
  const deadlineAt = Date.now() + 50_000;
  let runs: Array<CronRun<OperationalResult>>;
  try {
    // A cold Neon endpoint can refuse the first query of the run, which used to
    // lose the entire 15-minute slot — every queue below it simply did not run.
    // Only connection faults retry; anything else propagates on attempt one.
    runs = await withDbRetry(
      () =>
        runCronPerTenant(async () => runOperationalQueues(), {
          maxRuntimeMs: 45_000,
          minStartBudgetMs: 8_000,
          concurrency: 2,
          rotationWindowMs: 15 * 60 * 1000,
          onError: (tenantId, error) => logError(`automations-tenant:${tenantId}`, error),
        }),
      {
        deadlineAt,
        onRetry: (attempt, error) => logError("cron-db-retry", error, `automations attempt ${attempt}`),
      },
    );
  } finally {
    await runGlobalMaintenance();
  }

  const dormant = runs.length === 1 && runs[0].tenantId === null ? runs[0] : null;
  if (dormant?.status === "ok") return NextResponse.json({ ok: true, ...dormant.result });
  return NextResponse.json({ ok: true, tenants: runs });
}
