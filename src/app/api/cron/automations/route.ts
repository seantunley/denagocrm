import { NextRequest, NextResponse } from "next/server";
import { pruneRateLimits } from "@/lib/rateLimit";

export const maxDuration = 60;
import { runServiceReminders } from "@/lib/serviceReminders";
import { runSignatureRequestReminders } from "@/lib/signingReminders";
import { recoverStaleSigningClaims } from "@/lib/signing/dispatch";
import { recoverStrandedCompletions } from "@/lib/signing/recoverCompletions";
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
import { runRepairsDetectors } from "@/lib/repairsDetectors";
import { runAiHealthIfDue, runBackupWatchdog } from "@/lib/systemHealth";
import { basePrisma } from "@/lib/db";
import { expireReservations } from "@/lib/stockPlatform";
import { resolveTenantActor } from "@/lib/tenantActor";
import { runCronPerTenant, type CronRun, type CronSliceContext } from "@/lib/tenantCron";
import { withSystemScope } from "@/lib/tenantScopeEntry";
import { DEFAULT_TENANT_ID } from "@/lib/tenant";

/**
 * Time to keep in hand before starting another queue. Each of these makes
 * network calls — email, Meta, Google, IMAP, an AI provider — so one can take
 * seconds. Without the reserve, a queue admitted at the very edge of the budget
 * is the one that gets killed mid-write.
 */
const PHASE_RESERVE_MS = 6_000;

async function runOperationalQueues(tenantId: string | null, budget: CronSliceContext) {
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

  // "idle-automations" and "lifecycle-journeys" used to run here. Both are
  // retired: idle-lead nudges and the anniversary / win-back emails are now
  // Journey triggers (lead_idle, purchase_anniversary, win_back) enrolled by
  // runScheduledJourneyEnrollments on /api/cron/journeys. Running them here as
  // well is exactly how a tenant got TWO anniversary emails — the three dedupe
  // stores (AutomationLog, JourneyEvent.dedupeKey, Communication.subject LIKE)
  // could not see each other.
  const remindersSent = on("automotive") ? await phase("service-reminders", runServiceReminders, -1) : null;
  const signingReminders = await phase("signature-request-reminders", runSignatureRequestReminders, -1);
  const staleSigningClaims = await phase("stale-signing-claims", recoverStaleSigningClaims, null);
  // Completions that committed but never notified anyone. Runs alongside the
  // stale-claim sweep because it is the same class of problem at the other end
  // of the lifecycle: work the request can no longer re-drive by itself.
  //
  // ONE concrete tenant per sweep, passed explicitly. This sweep emails a signed
  // contract using SMTP credentials resolved from the tenant scope, so an
  // unscoped run could post one tenant's contract out over another's mail
  // identity. In dormant mode runCronPerTenant hands the slice `null` while
  // binding the FOUNDING tenant's scope, so that is the tenant this sweep is
  // for — named here rather than inferred inside the sweep.
  const strandedCompletions = await phase(
    "stranded-completions",
    () => recoverStrandedCompletions(tenantId ?? DEFAULT_TENANT_ID),
    null,
  );
  const fbLeads = on("marketing") ? await phase("meta-lead-sync", syncFacebookLeads, -1) : null;
  const googleReviews = on("marketing") ? await phase("google-reviews", syncGoogleReviews, -1) : null;
  const inboundEmail = await phase("imap-sync", syncInboundEmail, -1);
  const activityReminders = await phase("activity-reminders", runActivityReminders, -1);
  const aiResearch = await phase("ai-auto-research", runAutoResearch, -1);
  const campaignSent = on("marketing") ? await phase("campaign-queue", runSafeCampaignQueue, -1) : null;
  const surveyQueue = on("marketing")
    ? await phase("survey-distribution-queue", runSafeSurveyDistributionQueue, -1)
    : null;
  const stockActor = on("commerce")
    ? await phase("stock-actor", () => resolveTenantActor({ ownerOnly: true }), null)
    : null;
  const stockReservationsExpired = !on("commerce")
    ? null
    : stockActor
      ? await phase("stock-reservation-expiry", () => expireReservations(stockActor), -1)
      : 0;
  // LAST, and through the same budget gate as everything above it. The repairs
  // detectors read; the queues above them SEND. A tick that spent its last
  // seconds noticing a problem instead of delivering a message would be the
  // wrong trade every time, and `phase` skipping this is harmless — the next
  // tick asks the same questions and gets the same answers.
  const repairs = await phase("repairs-detectors", runRepairsDetectors, null);
  return {
    remindersSent,
    signingReminders,
    staleSigningClaims,
    strandedCompletions,
    fbLeads,
    googleReviews,
    inboundEmail,
    aiResearch,
    campaignSent,
    surveyQueue,
    activityReminders,
    stockReservationsExpired,
    repairs,
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
    // SecurityRateLimit keys come from caller-supplied input (IPs, signing
    // tokens), so the table grows with traffic — including hostile traffic —
    // and nothing else ever removed a row.
    await pruneRateLimits().catch(() => {});
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
    runs = await runCronPerTenant(async (tenantId, budget) => runOperationalQueues(tenantId, budget), {
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
