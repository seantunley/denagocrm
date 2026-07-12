import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60; // IMAP + Graph sync can take a few seconds
import { runIdleAutomations } from "@/lib/automations";
import { runJourneyEngine } from "@/lib/journeys";
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
import { basePrisma } from "@/lib/db";

/**
 * Runs scheduled CRM work. Vercel Cron authenticates with CRON_SECRET; the
 * intake API key remains available for an authorised manual health check.
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
  const journeyEngine = await runJourneyEngine().catch((e) => {
    logError("journey-engine", e);
    return { recoveredEvents: -1, recoveredRuns: -1, scheduled: -1, eventsProcessed: -1, enrolled: -1, runsProcessed: -1 };
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
  // Legacy opt-in anniversary/win-back settings remain supported until their
  // equivalent advanced journey is explicitly activated.
  const lifecycleSent = await runLifecycleJourneys().catch((e) => { logError("lifecycle-journeys", e); return -1; });
  await basePrisma.errorLog
    .deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } } })
    .catch(() => {});

  return NextResponse.json({
    ok: true,
    fired,
    journeyEngine,
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
