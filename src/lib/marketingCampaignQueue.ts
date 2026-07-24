import { basePrisma } from "./db";
import { sendEmail, renderTemplate } from "./email";
import { sendSms } from "./sms";
import { buildTrackedEmail } from "./campaigns";
import { canContactPerson, type CommunicationChannel } from "./communicationPolicy";
import { contactName } from "./format";

const BATCH_SIZE = 50;
const STALE_CLAIM_MINUTES = 15;

type ClaimedRecipient = {
  id: string;
  tenantId: string | null;
  campaignId: string;
  contactId: string;
  token: string;
  attemptCount: number;
  channel: string;
  subject: string | null;
  body: string;
  htmlBody: string | null;
  campaignName: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
};

async function event(args: {
  tenantId: string | null;
  campaignId: string;
  recipientId?: string;
  contactId?: string;
  type: string;
  metadata?: Record<string, unknown>;
}) {
  await basePrisma.$executeRaw`
    INSERT INTO "CampaignEvent" ("id", "tenantId", "campaignId", "campaignRecipientId", "contactId", "type", "metadata", "occurredAt")
    VALUES (${`ce_${crypto.randomUUID()}`}, ${args.tenantId}, ${args.campaignId}, ${args.recipientId ?? null}, ${args.contactId ?? null}, ${args.type}, ${JSON.stringify(args.metadata ?? {})}::jsonb, CURRENT_TIMESTAMP)
  `;
}

async function activateDueCampaigns() {
  await basePrisma.$executeRaw`
    UPDATE "Campaign" SET "status" = 'queued', "updatedAt" = CURRENT_TIMESTAMP
    WHERE "status" = 'scheduled' AND "scheduledFor" <= CURRENT_TIMESTAMP
  `;
  await basePrisma.$executeRaw`
    UPDATE "CampaignRecipient" r SET "status" = 'queued'
    FROM "Campaign" c
    WHERE r."campaignId" = c."id" AND c."status" = 'queued' AND r."status" = 'pending'
  `;
}

async function recoverStaleClaims() {
  await basePrisma.$executeRaw`
    UPDATE "CampaignRecipient" SET "status" = 'queued'
    WHERE "status" = 'sending' AND "lastAttemptAt" < CURRENT_TIMESTAMP - (${STALE_CLAIM_MINUTES} * INTERVAL '1 minute')
  `;
}

async function claimBatch(limit = BATCH_SIZE): Promise<ClaimedRecipient[]> {
  return basePrisma.$queryRaw<ClaimedRecipient[]>`
    WITH candidates AS (
      SELECT r."id"
      FROM "CampaignRecipient" r
      JOIN "Campaign" c ON c."id" = r."campaignId"
      WHERE r."status" IN ('queued', 'failed_temporary')
        AND c."status" IN ('queued', 'sending')
      ORDER BY c."createdAt", r."id"
      FOR UPDATE OF r SKIP LOCKED
      LIMIT ${limit}
    ), claimed AS (
      UPDATE "CampaignRecipient" r
      SET "status" = 'sending', "attemptCount" = r."attemptCount" + 1, "lastAttemptAt" = CURRENT_TIMESTAMP
      FROM candidates x
      WHERE r."id" = x."id"
      RETURNING r.*
    )
    SELECT r."id", r."tenantId", r."campaignId", r."contactId", r."token", r."attemptCount",
      c."channel", c."subject", c."body", c."htmlBody", c."name" AS "campaignName",
      p."firstName", p."lastName", p."email", p."phone", p."whatsapp"
    FROM claimed r
    JOIN "Campaign" c ON c."id" = r."campaignId"
    JOIN "Contact" p ON p."id" = r."contactId"
  `;
}

async function suppress(recipient: ClaimedRecipient, reason: string) {
  await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE "CampaignRecipient" SET "status" = 'suppressed', "suppressionReason" = ${reason} WHERE "id" = ${recipient.id}`;
    await tx.$executeRaw`UPDATE "Campaign" SET "suppressedCount" = "suppressedCount" + 1 WHERE "id" = ${recipient.campaignId}`;
  });
  await event({ tenantId: recipient.tenantId, campaignId: recipient.campaignId, recipientId: recipient.id, contactId: recipient.contactId, type: "suppressed", metadata: { reason } });
}

function channelFor(value: string): CommunicationChannel {
  return value === "email" ? "email" : "sms";
}

async function deliver(recipient: ClaimedRecipient) {
  const campaignState = await basePrisma.campaign.findUnique({ where: { id: recipient.campaignId }, select: { status: true } });
  if (!campaignState || !new Set(["queued", "sending"]).has(campaignState.status)) {
    await basePrisma.campaignRecipient.update({ where: { id: recipient.id }, data: { status: campaignState?.status === "cancelled" ? "cancelled" : "queued" } });
    return;
  }

  const eligibility = await canContactPerson({
    contactId: recipient.contactId,
    tenantId: recipient.tenantId,
    purpose: "marketing",
    requestedChannel: channelFor(recipient.channel),
    campaignId: recipient.campaignId,
  });
  if (!eligibility.allowed || !eligibility.destination) {
    await suppress(recipient, eligibility.reason ?? "policy_blocked");
    return;
  }

  await event({ tenantId: recipient.tenantId, campaignId: recipient.campaignId, recipientId: recipient.id, contactId: recipient.contactId, type: "send_attempt", metadata: { attempt: recipient.attemptCount } });
  const vars = { first_name: recipient.firstName, name: contactName(recipient) };
  const result = recipient.channel === "email"
    ? await sendEmail({
        to: eligibility.destination,
        subject: renderTemplate(recipient.subject ?? "", vars),
        text: renderTemplate(recipient.body, vars),
        html: buildTrackedEmail(renderTemplate(recipient.htmlBody ?? recipient.body, vars), recipient.token),
      })
    : await sendSms(eligibility.destination, renderTemplate(recipient.body, vars));

  if (result.ok) {
    await basePrisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "CampaignRecipient" SET "status" = 'sent', "sentAt" = CURRENT_TIMESTAMP, "providerStatus" = 'accepted', "error" = NULL WHERE "id" = ${recipient.id}`;
      await tx.$executeRaw`UPDATE "Campaign" SET "sentCount" = "sentCount" + 1, "status" = CASE WHEN "status" = 'queued' THEN 'sending' ELSE "status" END WHERE "id" = ${recipient.campaignId}`;
    });
    await event({ tenantId: recipient.tenantId, campaignId: recipient.campaignId, recipientId: recipient.id, contactId: recipient.contactId, type: "sent" });
  } else {
    const temporary = recipient.attemptCount < 3;
    await basePrisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "CampaignRecipient" SET "status" = ${temporary ? "failed_temporary" : "failed_permanent"}, "error" = ${(result.error ?? "send failed").slice(0, 500)} WHERE "id" = ${recipient.id}`;
      if (!temporary) await tx.$executeRaw`UPDATE "Campaign" SET "failedCount" = "failedCount" + 1 WHERE "id" = ${recipient.campaignId}`;
    });
    await event({ tenantId: recipient.tenantId, campaignId: recipient.campaignId, recipientId: recipient.id, contactId: recipient.contactId, type: "failed", metadata: { temporary, error: result.error ?? "send failed" } });
  }
}

async function finaliseCampaigns() {
  await basePrisma.$executeRaw`
    UPDATE "Campaign" c SET
      "status" = CASE WHEN c."failedCount" > 0 OR c."suppressedCount" > 0 THEN 'completed_with_errors' ELSE 'completed' END,
      "completedAt" = CURRENT_TIMESTAMP,
      "sentAt" = COALESCE(c."sentAt", CURRENT_TIMESTAMP),
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE c."status" = 'sending'
      AND NOT EXISTS (
        SELECT 1 FROM "CampaignRecipient" r
        WHERE r."campaignId" = c."id" AND r."status" IN ('pending', 'queued', 'sending', 'failed_temporary')
      )
  `;
}

export async function runSafeCampaignQueue(maxTotal = 150) {
  await activateDueCampaigns();
  await recoverStaleClaims();
  let processed = 0;
  while (processed < maxTotal) {
    const batch = await claimBatch(Math.min(BATCH_SIZE, maxTotal - processed));
    if (batch.length === 0) break;
    for (const recipient of batch) await deliver(recipient);
    processed += batch.length;
  }
  await finaliseCampaigns();
  return processed;
}
