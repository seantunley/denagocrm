import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60; // IMAP + Graph sync can take a few seconds
import { runIdleAutomations } from "@/lib/automations";
import { runServiceReminders } from "@/lib/serviceReminders";
import { runQuoteSigningReminders } from "@/lib/signingReminders";
import { syncFacebookLeads } from "@/lib/metaLeadSync";
import { syncGoogleReviews } from "@/lib/googleReviews";
import { syncInboundEmail } from "@/lib/imapSync";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { logError } from "@/lib/errorLog";
import { runAutoResearch } from "@/lib/ai";
import { runActivityReminders } from "@/lib/activityReminders";
import { runCampaignQueue } from "@/lib/campaigns";
import { runSurveyQueue } from "@/lib/surveys";
import { runLifecycleJourneys } from "@/lib/lifecycleJourneys";
import { runAiHealthIfDue, runBackupWatchdog } from "@/lib/systemHealth";
import { basePrisma } from "@/lib/db";
import { expireReservations } from "@/lib/stockPlatform";

/**
 * Runs recurring operational queues. Invoked by Vercel Cron with
 *   Authorization: Bearer <CRON_SECRET>
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const fired = await runIdleAutomations();
  const remindersSent = await runServiceReminders().catch((e) => { logError("service-reminders", e); return -1; });
  const quoteReminders = await runQuoteSigningReminders().catch((e) => { logError("quote-reminders", e); return -1; });
  const fbLeads = await syncFacebookLeads().catch((e) => { logError("meta-lead-sync", e); return -1; });
  const googleReviews = await syncGoogleReviews().catch((e) => { logError("google-reviews", e); return -1; });
  const inboundEmail = await syncInboundEmail().catch((e) => { logError("imap-sync", e); return -1; });
  const activityReminders = await runActivityReminders().catch((e) => { logError("activity-reminders", e); return -1; });
  const aiResearch = await runAutoResearch().catch((e) => { logError("ai-auto-research", e); return -1; });
  const campaignSent = await runCampaignQueue().catch((e) => { logError("campaign-queue", e); return -1; });
  const surveysSent = await runSurveyQueue().catch((e) => { logError("survey-queue", e); return -1; });
  const lifecycleSent = await runLifecycleJourneys().catch((e) => { logError("lifecycle-journeys", e); return -1; });
  const stockActor = await basePrisma.user.findFirst({ where: { role: "owner" }, orderBy: { createdAt: "asc" }, select: { id: true, name: true } });
  const stockReservationsExpired = stockActor
    ? await expireReservations(stockActor).catch((e) => { logError("stock-reservation-expiry", e); return -1; })
    : 0;
  await runAiHealthIfDue().catch((e) => logError("ai-health", e));
  await runBackupWatchdog().catch(() => {});
  await basePrisma.errorLog
    .deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } } })
    .catch(() => {});
  return NextResponse.json({
    ok: true,
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
  });
}
