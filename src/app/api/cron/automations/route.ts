import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60; // IMAP + Graph sync can take a few seconds
import { runIdleAutomations } from "@/lib/automations";
import { runServiceReminders } from "@/lib/serviceReminders";
import { runQuoteSigningReminders } from "@/lib/signingReminders";
import { syncFacebookLeads } from "@/lib/metaLeadSync";
import { syncGoogleReviews } from "@/lib/googleReviews";
import { syncInboundEmail } from "@/lib/imapSync";
import { getSetting } from "@/lib/settings";
import { logError } from "@/lib/errorLog";
import { runAutoResearch } from "@/lib/ai";
import { runActivityReminders } from "@/lib/activityReminders";
import { runCampaignQueue } from "@/lib/campaigns";
import { runSurveyQueue } from "@/lib/surveys";
import { runLifecycleJourneys } from "@/lib/lifecycleJourneys";
import { runMarketingJourneyQueue } from "@/lib/marketingJourneys";
import { basePrisma } from "@/lib/db";

/**
 * Runs legacy rules, durable multi-step journeys and operational queues.
 * Vercel Cron authenticates with CRON_SECRET; INTAKE_API_KEY remains available
 * for an authorised manual run.
 */
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

  const fired = await runIdleAutomations();
  const journeyQueue = await runMarketingJourneyQueue().catch((e) => {
    logError("marketing-journeys", e);
    return { enrolled: -1, processed: -1, failed: -1 };
  });
  const remindersSent = await runServiceReminders().catch((e) => { logError("service-reminders", e); return -1; });
  const quoteReminders = await runQuoteSigningReminders().catch((e) => { logError("quote-reminders", e); return -1; });
  const fbLeads = await syncFacebookLeads().catch((e) => { logError("meta-lead-sync", e); return -1; });
  const googleReviews = await syncGoogleReviews().catch((e) => { logError("google-reviews", e); return -1; });
  const inboundEmail = await syncInboundEmail().catch((e) => { logError("imap-sync", e); return -1; });
  const activityReminders = await runActivityReminders().catch((e) => { logError("activity-reminders", e); return -1; });
  const aiResearch = await runAutoResearch().catch((e) => { logError("ai-auto-research", e); return -1; });
  const campaignSent = await runCampaignQueue().catch((e) => { logError("campaign-queue", e); return -1; });
  const surveysSent = await runSurveyQueue().catch((e) => { logError("survey-queue", e); return -1; });
  // Existing hard-coded anniversary/win-back settings remain operational during
  // migration. Disable them after equivalent published journeys are live.
  const lifecycleSent = await runLifecycleJourneys().catch((e) => { logError("lifecycle-journeys", e); return -1; });

  await basePrisma.errorLog
    .deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } } })
    .catch(() => {});

  return NextResponse.json({
    ok: true,
    fired,
    journeyQueue,
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
  });
}
