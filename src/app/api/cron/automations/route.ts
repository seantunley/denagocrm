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
import { warmUpForCron } from "@/lib/cronPreflight";
import { runAutoResearch } from "@/lib/ai";
import { runActivityReminders } from "@/lib/activityReminders";
import { runSafeCampaignQueue } from "@/lib/marketingCampaignQueue";
import { runSafeSurveyDistributionQueue } from "@/lib/surveyDistributionQueue";
import { runLifecycleJourneys } from "@/lib/lifecycleJourneys";
import { runAiHealthIfDue, runBackupWatchdog } from "@/lib/systemHealth";
import { basePrisma } from "@/lib/db";
import { expireReservations } from "@/lib/stockPlatform";
import { resolveTenantActor } from "@/lib/tenantActor";
import { runCronPerTenant, type CronRun, type CronSliceContext } from "@/lib/tenantCron";
import { withSystemScope } from "@/lib/tenantScopeEntry";

/**
 * Time to keep in hand before starting another queue. Each of these makes
 * network calls — email, Meta, Google, IMAP, an AI provider — so one can take
 * seconds. Without the reserve, a queue admitted at the very edge of the budget
 * is the one that gets killed mid-write.
 */
const PHASE_RESERVE_MS = 6_000;

async function runOperationalQueues(budget: CronSliceContext) {
  const enabled = await getEnabledModuleIds().catch(() => null);
  const on = (id: ModuleId) => enabled === null || enabled.has(id);
  const skipped: string[] = [];

  /**
   * Runs one queue, unless the route budget is nearly spent.
   *
   * These queues SEND THINGS, so stopping cooperatively between them is the only
   * safe way to respect the deadline: the runner cannot cancel work already in
   * flight, and racing a promise against a timer would abandon a half-finished
   * send rather than prevent it.
   */
  const phase = async <T, F>(name: string, run: () => Promise<T>, fallback: F): Promise<T | F> => {
    if (budget.shouldStop(PHASE_RESERVE_MS)) {
      skipped.push(name);
      return fallback;
    }
    return run().catch((e) => {
      logError(name, e);
      return fallback;
    });
  };

  const fired = await phase("idle-automations", runIdleAutomations, -1);
  const remindersSent = on("automotive") ? await phase("service-reminders", runServiceReminders, -1) : null;
  const signingReminders = await phase("signature-request-reminders", runSignatureRequestReminders, -1);
  const staleSigningClaims = await phase("stale-signing-claims", recoverStaleSigningClaims, null);
  const fbLeads = on("marketing") ? await phase("meta-lead-sync", syncFacebookLeads, -1) : null;
  const googleReviews = on("marketing") ? await phase("google-reviews", syncGoogleReviews, -1) : null;
  const inboundEmail = await phase("imap-sync", syncInboundEmail, -1);
  const activityReminders = await phase("activity-reminders", runActivityReminders, -1);
  const aiResearch = await phase("ai-auto-research", runAutoResearch, -1);
  const campaignSent = on("marketing") ? await phase("campaign-queue", runSafeCampaignQueue, -1) : null;
  const surveyQueue = on("marketing")
    ? await phase("survey-distribution-queue", runSafeSurveyDistributionQueue, -1)
    : null;
  const lifecycleSent = on("marketing") ? await phase("lifecycle-journeys", runLifecycleJourneys, -1) : null;
  const stockActor = on("commerce")
    ? await phase("stock-actor", () => resolveTenantActor({ ownerOnly: true }), null)
    : null;
  const stockReservationsExpired = !on("commerce")
    ? null
    : stockActor
      ? await phase("stock-reservation-expiry", () => expireReservations(stockActor), -1)
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
    // Visible in the response so a truncated run is diagnosable rather than
    // looking like a clean sweep that found nothing to do.
    skipped,
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

  // Wake a suspended Neon endpoint BEFORE the sweep. The sweep sends emails and
  // pushes, so it must run exactly once; only the harmless preflight retries.
  //
  // 45s of the 60s maxDuration, leaving room for runGlobalMaintenance in the
  // finally. Whatever waking the database costs comes OUT of that, so the sweep
  // can never start a full-length run on a budget that has already been spent.
  const MIN_START_BUDGET_MS = 8_000;
  const routeBudget = await warmUpForCron("automations", {
    routeBudgetMs: 45_000,
    minStartBudgetMs: MIN_START_BUDGET_MS,
  });
  if (!routeBudget.ok) {
    return NextResponse.json({ ok: false, skipped: routeBudget.reason }, { status: 503 });
  }

  let runs: Array<CronRun<OperationalResult>>;
  try {
    runs = await runCronPerTenant(async (_tenantId, budget) => runOperationalQueues(budget), {
      maxRuntimeMs: routeBudget.remainingMs,
      minStartBudgetMs: MIN_START_BUDGET_MS,
      concurrency: 2,
      rotationWindowMs: 15 * 60 * 1000,
      onError: (tenantId, error) => logError(`automations-tenant:${tenantId}`, error),
    });
  } finally {
    await runGlobalMaintenance();
  }

  const dormant = runs.length === 1 && runs[0].tenantId === null ? runs[0] : null;
  if (dormant?.status === "ok") return NextResponse.json({ ok: true, ...dormant.result });
  return NextResponse.json({ ok: true, tenants: runs });
}
