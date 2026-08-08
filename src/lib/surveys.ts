import "server-only";

import { basePrisma, prisma } from "./db";
import { sendEmail } from "./email";
import { sendSms } from "./sms";
import { logAudit } from "./audit";
import { resolveTenantActor } from "./tenantActor";
import { defaultIntro, type SurveyType } from "./surveyTypes";
import { DEFAULT_BRAND, brandForTenant } from "./tenantBrand";
import { tenantOrigin } from "./tenantOrigin";
import { createSurveyDistribution } from "./surveyDistributionQueue";
import { submitFrozenSurveyResponse, triggerGovernedSurvey } from "./governedSurveyRuntime";

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || "https://crm.denagocpt.co.za").replace(/\/$/, "");
export const surveyUrl = (token: string, origin?: string | null) => `${origin || APP_URL}/s/${token}`;

type SurveyLite = { id: string; title: string; type: string; intro: string | null };
type PublishedSurvey = SurveyLite & { tenantId: string | null; publishedVersion: number; delayHours: number };

export type SurveyTarget = {
  contactId?: string | null;
  leadId?: string | null;
  jobCardId?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
};

/**
 * The SUBJECT LINE of a survey invitation — the part a customer reads before
 * they open anything. Two of the four named Denago outright ("Enjoying your new
 * Denago?", "One quick question from Denago Cape Town"), so every tenant's
 * customers were asked about a brand they had not bought.
 *
 * `sender` is the workspace's own name. The sales subject drops the brand
 * reference entirely rather than substituting into it — "Enjoying your new Acme
 * Golf Carts?" reads as a question about the company, not the machine.
 */
function subjectFor(type: SurveyType, title: string, sender: string): string {
  switch (type) {
    case "csat": return "How was your service? A quick question ⭐";
    case "sales": return "Enjoying your purchase? Tell us how we did ⭐";
    case "nps": return `One quick question from ${sender}`;
    default: return title;
  }
}

type Recipient = { name: string | null; email: string | null; phone: string | null; optOut: boolean };

async function publishedSurvey(surveyId: string): Promise<PublishedSurvey | null> {
  const rows = await basePrisma.$queryRaw<PublishedSurvey[]>`
    SELECT "id", "title", "type", "intro", "tenantId", "publishedVersion", "delayHours"
    FROM "Survey"
    WHERE "id" = ${surveyId}
      AND "status" = 'published'
      AND "active" = true
      AND "publishedVersion" IS NOT NULL
      AND "deletedAt" IS NULL
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function resolveRecipient(target: SurveyTarget): Promise<Recipient> {
  let name = target.name ?? null;
  let email = target.email ?? null;
  let phone = target.phone ?? null;
  let optOut = false;
  if (target.contactId) {
    const contact = await prisma.contact.findUnique({ where: { id: target.contactId } });
    if (contact) {
      email = email ?? contact.email;
      phone = phone ?? contact.whatsapp ?? contact.phone;
      name = name ?? [contact.firstName, contact.lastName].filter(Boolean).join(" ");
      optOut = contact.marketingOptOut;
    }
  }
  return { name, email, phone, optOut };
}

async function recentlySurveyed(contactId: string, surveyId: string, tenantId: string | null) {
  const rows = await basePrisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS "count"
    FROM "SurveyResponse"
    WHERE "tenantId" IS NOT DISTINCT FROM ${tenantId}
      AND "surveyId" = ${surveyId}
      AND "contactId" = ${contactId}
      AND COALESCE("inviteSentAt", "sentAt", "scheduledFor") >= CURRENT_TIMESTAMP - INTERVAL '30 days'
      AND "status" NOT IN ('cancelled', 'suppressed', 'failed', 'failed_permanent')
  `;
  return Number(rows[0]?.count ?? 0) > 0;
}

async function deliverInvite(
  response: { id: string; token: string; contactId: string | null },
  survey: PublishedSurvey,
  recipient: { name: string | null; email: string | null; phone: string | null },
): Promise<"email" | "sms" | null> {
  // The survey lives on the workspace's own domain, and the mail is signed with
  // its own name — this said "Denago Cape Town" to every tenant's customers.
  const [origin, brand] = await Promise.all([
    tenantOrigin(survey.tenantId),
    brandForTenant(survey.tenantId).catch(() => DEFAULT_BRAND),
  ]);
  const link = surveyUrl(response.token, origin);
  const first = (recipient.name ?? "there").split(/\s+/)[0] || "there";
  const intro = survey.intro || defaultIntro(survey.type as SurveyType);
  let channel: "email" | "sms" | null = null;

  if (recipient.email) {
    const result = await sendEmail({
      to: recipient.email,
      subject: subjectFor(survey.type as SurveyType, survey.title, brand.displayName),
      text: `Hi ${first},\n\n${intro}\n\nTap here to answer (it takes under a minute):\n${link}\n\nThank you,\n${brand.displayName}`,
    });
    if (result.ok) channel = "email";
  } else if (recipient.phone) {
    const result = await sendSms(recipient.phone, `Hi ${first}, ${intro} ${link}`);
    if (result.ok) channel = "sms";
  }
  if (!channel) return null;

  await basePrisma.$executeRaw`
    UPDATE "SurveyResponse"
    SET "surveyVersion" = ${survey.publishedVersion}, "status" = 'sent', "channel" = ${channel},
      "inviteSentAt" = CURRENT_TIMESTAMP, "sentAt" = CURRENT_TIMESTAMP, "providerStatus" = 'accepted'
    WHERE "id" = ${response.id}
      AND "tenantId" IS NOT DISTINCT FROM ${survey.tenantId}
  `;

  if (response.contactId) {
    const actor = await resolveTenantActor();
    if (actor) {
      await prisma.communication.create({
        data: {
          type: channel,
          direction: "outbound",
          subject: `Survey sent: ${survey.title}`,
          body: `"${survey.title}" survey invitation sent via ${channel}.`,
          contactId: response.contactId,
          userId: actor.id,
        },
      });
    }
  }
  await logAudit({
    action: "survey.sent",
    summary: `Sent "${survey.title}" version ${survey.publishedVersion} to ${recipient.name ?? recipient.email ?? recipient.phone}`,
    contactId: response.contactId ?? undefined,
    userName: "System",
  });
  return channel;
}

/** Single-recipient test/manual delivery only. Audience delivery uses SurveyDistribution. */
export async function sendSurvey(input: SurveyLite, target: SurveyTarget): Promise<boolean> {
  const survey = await publishedSurvey(input.id);
  if (!survey) return false;
  const contactId = target.contactId ?? null;
  const recipient = await resolveRecipient(target);
  if (recipient.optOut && (survey.type === "nps" || survey.type === "adhoc")) return false;
  if (!recipient.email && !recipient.phone) return false;
  if (contactId && await recentlySurveyed(contactId, survey.id, survey.tenantId)) return false;

  const response = await prisma.surveyResponse.create({
    data: {
      surveyId: survey.id,
      contactId,
      leadId: target.leadId ?? null,
      jobCardId: target.jobCardId ?? null,
      name: recipient.name,
      channel: recipient.email ? "email" : "sms",
      status: "queued",
    },
  });
  const channel = await deliverInvite(response, survey, recipient);
  if (!channel) {
    await basePrisma.$executeRaw`
      UPDATE "SurveyResponse"
      SET "status" = 'failed_permanent', "providerStatus" = 'failed'
      WHERE "id" = ${response.id} AND "tenantId" IS NOT DISTINCT FROM ${survey.tenantId}
    `;
  }
  return Boolean(channel);
}

/** Compatibility helper now creates a durable one-contact distribution. */
export async function scheduleSurvey(input: SurveyLite & { delayHours: number }, target: SurveyTarget): Promise<boolean> {
  const survey = await publishedSurvey(input.id);
  if (!survey || !target.contactId) return false;
  if (await recentlySurveyed(target.contactId, survey.id, survey.tenantId)) return false;
  const actor = await resolveTenantActor();
  if (!actor) return false;
  await createSurveyDistribution({
    tenantId: survey.tenantId,
    userId: actor.id,
    surveyId: survey.id,
    name: `${survey.title} · scheduled`,
    purpose: survey.type === "nps" || survey.type === "adhoc" ? "survey_marketing" : "survey_transactional",
    channel: "any",
    contactIds: [target.contactId],
    audienceSnapshot: { source: "legacy_schedule_helper", contactId: target.contactId },
    scheduledFor: new Date(Date.now() + Math.max(1, input.delayHours) * 3_600_000),
  });
  return true;
}

/** The legacy survey queue is retired; the tenant cron runs SurveyDistribution. */
export async function runSurveyQueue(): Promise<number> {
  return 0;
}

export async function triggerSurvey(trigger: string, target: SurveyTarget): Promise<void> {
  await triggerGovernedSurvey(trigger, target);
}

export async function submitResponse(token: string, answers: Record<string, unknown>) {
  return submitFrozenSurveyResponse(token, answers);
}
