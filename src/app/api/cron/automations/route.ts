import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60; // IMAP + Graph sync can take a few seconds
import { runIdleAutomations } from "@/lib/automations";
import { runServiceReminders } from "@/lib/serviceReminders";
import { runQuoteSigningReminders } from "@/lib/signingReminders";
import { syncFacebookLeads } from "@/lib/metaLeadSync";
import { syncGoogleReviews } from "@/lib/googleReviews";
import { syncInboundEmail } from "@/lib/imapSync";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { getEnabledModuleIds } from "@/lib/modules/enabled";
import type { ModuleId } from "@/lib/modules/registry";
import { logError } from "@/lib/errorLog";
import { runAutoResearch } from "@/lib/ai";
import { runActivityReminders } from "@/lib/activityReminders";
import { runCampaignQueue } from "@/lib/campaigns";
import { runSurveyQueue } from "@/lib/surveys";
import { runLifecycleJourneys } from "@/lib/lifecycleJourneys";
import { runAiHealthIfDue, runBackupWatchdog } from "@/lib/systemHealth";
import { basePrisma } from "@/lib/db";
import { expireReservations } from "@/lib/stockPlatform";
import { resolveTenantActor } from "@/lib/tenantActor";
import { runCronPerTenant, type CronRun } from "@/lib/tenantCron";
import { withSystemScope } from "@/lib/tenantScopeEntry";

/**
 * The per-tenant operational queues (idle automations, reminders, marketing
 * queues, stock-reservation expiry, inbound email filing). Under enforcement this
 * runs once per active tenant inside that tenant's scope, so every worker's
 * guarded queries + the stock owner pick are confined to the tenant; dormant it
 * runs once, unscoped — byte-for-byte the pre-tenancy sweep.
 */
async function runOperationalQueues() {
  // Load the enabled module set once, then skip any worker whose owning optional
  // pack is off — the cron must not keep a disabled module's queues running.
  // `null` in the response marks "skipped (module off)", distinct from 0 (ran,
  // nothing to do) and -1 (errored). Ungated workers below are core (no owning
  // optional module): idle lead automations, quote-signing reminders, inbound
  // email filing, activity reminders, AI lead enrichment.
  const enabled = await getEnabledModuleIds().catch(() => null);
  const on = (id: ModuleId) => enabled === null || enabled.has(id);

  const fired = await runIdleAutomations();
  const remindersSent = on("automotive")
    ? await runServiceReminders().catch((e) => { logError("service-reminders", e); return -1; })
    : null;
  const quoteReminders = await runQuoteSigningReminders().catch((e) => { logError("quote-reminders", e); return -1; });
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
    ? await runCampaignQueue().catch((e) => { logError("campaign-queue", e); return -1; })
    : null;
  const surveysSent = on("marketing")
    ? await runSurveyQueue().catch((e) => { logError("survey-queue", e); return -1; })
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
    quoteReminders,
    fbLeads,
    googleReviews,
    inboundEmail,
    aiResearch,
    campaignSent,
    surveysSent,
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

/**
 * Runs recurring operational queues. Invoked by Vercel Cron with
 *   Authorization: Bearer <CRON_SECRET>
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let runs: Array<CronRun<OperationalResult>>;
  try {
    // The helper isolates tenant failures, rotates the start tenant, and stops
    // admitting new slices before the route deadline.
    runs = await runCronPerTenant(async () => runOperationalQueues(), {
      maxRuntimeMs: 45_000,
      minStartBudgetMs: 8_000,
      concurrency: 2,
      rotationWindowMs: 15 * 60 * 1000,
      onError: (tenantId, error) => logError(`automations-tenant:${tenantId}`, error),
    });
  } finally {
    // Platform-global maintenance runs exactly once and is not starved by a failed
    // tenant slice or tenant-enumeration error. In dormant mode the original error
    // still propagates after this finally block, preserving the legacy response.
    await runGlobalMaintenance();
  }

  const dormant = runs.length === 1 && runs[0].tenantId === null ? runs[0] : null;
  if (dormant?.status === "ok") {
    return NextResponse.json({ ok: true, ...dormant.result });
  }
  return NextResponse.json({ ok: true, tenants: runs });
}
