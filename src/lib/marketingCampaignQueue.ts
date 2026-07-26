import crypto from "node:crypto";
import { basePrisma } from "./db";
import { sendEmail, renderTemplate } from "./email";
import { sendSms } from "./sms";
import { buildTrackedEmail } from "./campaigns";
import { canContactPerson, classifyRetry, nextCommunicationWindow, type CommunicationChannel } from "./communicationPolicy";
import { contactName } from "./format";
import { currentTenantScope } from "./tenantScope";

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

function activeTenantId() {
  const scope = currentTenantScope();
  if (scope?.system) throw new Error("Campaign delivery must run in a tenant scope, not system scope");
  return scope?.tenantId ?? null;
}

async function event(args: {
  tenantId: string | null;
  campaignId: string;
  recipientId?: string;
  contactId?: string;
  type: string;
  metadata?: Record<string, unknown>;
}) {
  await basePrisma.$executeRaw`
    INSERT INTO "MarketingCampaignEvent" ("id", "tenantId", "campaignId", "campaignRecipientId", "contactId", "type", "metadata", "occurredAt")
    VALUES (${`mce_${crypto.randomUUID()}`}, ${args.tenantId}, ${args.campaignId}, ${args.recipientId ?? null}, ${args.contactId ?? null}, ${args.type}, ${JSON.stringify(args.metadata ?? {})}::jsonb, CURRENT_TIMESTAMP)
  `;
}

async function activateDueCampaigns(tenantId: string | null) {
  await basePrisma.$executeRaw`
    UPDATE "Campaign" SET "status" = 'queued', "updatedAt" = CURRENT_TIMESTAMP
    WHERE "tenantId" IS NOT DISTINCT FROM ${tenantId}
      AND "status" = 'scheduled' AND "scheduledFor" <= CURRENT_TIMESTAMP
  `;
  await basePrisma.$executeRaw`
    UPDATE "CampaignRecipient" r SET "status" = 'queued', "nextAttemptAt" = NULL
    FROM "Campaign" c
    WHERE r."campaignId" = c."id"
      AND c."tenantId" IS NOT DISTINCT FROM ${tenantId}
      AND r."tenantId" IS NOT DISTINCT FROM ${tenantId}
      AND c."status" = 'queued' AND r."status" = 'pending'
  `;
}

async function recoverStaleClaims(tenantId: string | null) {
  await basePrisma.$executeRaw`
    UPDATE "CampaignRecipient" SET "status" = 'queued', "nextAttemptAt" = CURRENT_TIMESTAMP, "providerStatus" = 'stale_claim_recovered'
    WHERE "tenantId" IS NOT DISTINCT FROM ${tenantId}
      AND "status" = 'sending'
      AND "lastAttemptAt" < CURRENT_TIMESTAMP - (${STALE_CLAIM_MINUTES} * INTERVAL '1 minute')
  `;
}

async function claimBatch(tenantId: string | null, limit = BATCH_SIZE): Promise<ClaimedRecipient[]> {
  return basePrisma.$queryRaw<ClaimedRecipient[]>`
    WITH candidates AS (
      SELECT r."id"
      FROM "CampaignRecipient" r
      JOIN "Campaign" c ON c."id" = r."campaignId"
      WHERE r."tenantId" IS NOT DISTINCT FROM ${tenantId}
        AND c."tenantId" IS NOT DISTINCT FROM ${tenantId}
        AND r."status" IN ('queued', 'failed_temporary')
        AND (r."nextAttemptAt" IS NULL OR r."nextAttemptAt" <= CURRENT_TIMESTAMP)
        AND c."status" IN ('queued', 'sending')
      ORDER BY c."createdAt", r."id"
      FOR UPDATE OF r SKIP LOCKED
      LIMIT ${limit}
    ), claimed AS (
      UPDATE "CampaignRecipient" r
      SET "status" = 'sending', "attemptCount" = r."attemptCount" + 1,
        "lastAttemptAt" = CURRENT_TIMESTAMP, "nextAttemptAt" = NULL
      FROM candidates x
      WHERE r."id" = x."id"
      RETURNING r.*
    )
    SELECT r."id", r."tenantId", r."campaignId", r."contactId", r."token", r."attemptCount",
      c."channel", c."subject", c."body", c."htmlBody", c."name" AS "campaignName",
      p."firstName", p."lastName", p."email", p."phone", p."whatsapp"
    FROM claimed r
    JOIN "Campaign" c ON c."id" = r."campaignId" AND c."tenantId" IS NOT DISTINCT FROM ${tenantId}
    JOIN "Contact" p ON p."id" = r."contactId" AND p."tenantId" IS NOT DISTINCT FROM ${tenantId}
  `;
}

async function suppress(recipient: ClaimedRecipient, reason: string) {
  const changed = await basePrisma.$transaction(async (tx) => {
    const updated = await tx.$executeRaw`
      UPDATE "CampaignRecipient"
      SET "status" = 'suppressed', "suppressionReason" = ${reason}, "providerStatus" = 'suppressed'
      WHERE "id" = ${recipient.id}
        AND "tenantId" IS NOT DISTINCT FROM ${recipient.tenantId}
        AND "status" = 'sending'
    `;
    if (updated === 1) {
      await tx.$executeRaw`
        UPDATE "Campaign" SET "suppressedCount" = "suppressedCount" + 1
        WHERE "id" = ${recipient.campaignId} AND "tenantId" IS NOT DISTINCT FROM ${recipient.tenantId}
      `;
    }
    return updated === 1;
  });
  if (changed) await event({ tenantId: recipient.tenantId, campaignId: recipient.campaignId, recipientId: recipient.id, contactId: recipient.contactId, type: "suppressed", metadata: { reason } });
}

async function defer(recipient: ClaimedRecipient, reason: string) {
  const now = new Date();
  const nextAttemptAt = reason === "quiet_hours"
    ? nextCommunicationWindow(now)
    : new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const updated = await basePrisma.$executeRaw`
    UPDATE "CampaignRecipient"
    SET "status" = 'queued', "nextAttemptAt" = ${nextAttemptAt},
      "providerStatus" = ${`deferred_${reason}`}, "suppressionReason" = NULL
    WHERE "id" = ${recipient.id}
      AND "tenantId" IS NOT DISTINCT FROM ${recipient.tenantId}
      AND "status" = 'sending'
  `;
  if (updated === 1) await event({ tenantId: recipient.tenantId, campaignId: recipient.campaignId, recipientId: recipient.id, contactId: recipient.contactId, type: "deferred", metadata: { reason, nextAttemptAt: nextAttemptAt.toISOString() } });
}

function channelFor(value: string): CommunicationChannel {
  return value === "email" ? "email" : "sms";
}

async function restoreClosedClaim(recipient: ClaimedRecipient, campaignStatus: string | undefined) {
  const status = campaignStatus === "paused" ? "queued" : "cancelled";
  await basePrisma.$executeRaw`
    UPDATE "CampaignRecipient"
    SET "status" = ${status}, "providerStatus" = ${campaignStatus ? `campaign_${campaignStatus}` : "campaign_missing"}
    WHERE "id" = ${recipient.id}
      AND "tenantId" IS NOT DISTINCT FROM ${recipient.tenantId}
      AND "status" = 'sending'
  `;
}

async function deliver(recipient: ClaimedRecipient) {
  const rows = await basePrisma.$queryRaw<Array<{ status: string }>>`
    SELECT "status" FROM "Campaign"
    WHERE "id" = ${recipient.campaignId} AND "tenantId" IS NOT DISTINCT FROM ${recipient.tenantId}
    LIMIT 1
  `;
  const campaignStatus = rows[0]?.status;
  if (!campaignStatus || !new Set(["queued", "sending"]).has(campaignStatus)) {
    await restoreClosedClaim(recipient, campaignStatus);
    return;
  }

  const eligibility = await canContactPerson({
    contactId: recipient.contactId,
    tenantId: recipient.tenantId,
    purpose: "marketing",
    requestedChannel: channelFor(recipient.channel),
    campaignId: recipient.campaignId,
    campaignRecipientId: recipient.id,
  });
  if (!eligibility.allowed || !eligibility.destination) {
    const reason = eligibility.reason ?? "policy_blocked";
    if (reason === "quiet_hours" || reason === "frequency_cap") await defer(recipient, reason);
    else await suppress(recipient, reason);
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
    const changed = await basePrisma.$transaction(async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE "CampaignRecipient"
        SET "status" = 'sent', "sentAt" = CURRENT_TIMESTAMP, "providerStatus" = 'accepted',
          "error" = NULL, "nextAttemptAt" = NULL
        WHERE "id" = ${recipient.id}
          AND "tenantId" IS NOT DISTINCT FROM ${recipient.tenantId}
          AND "status" = 'sending'
      `;
      if (updated === 1) {
        await tx.$executeRaw`
          UPDATE "Campaign"
          SET "sentCount" = "sentCount" + 1,
            "status" = CASE WHEN "status" = 'queued' THEN 'sending' ELSE "status" END
          WHERE "id" = ${recipient.campaignId} AND "tenantId" IS NOT DISTINCT FROM ${recipient.tenantId}
        `;
      }
      return updated === 1;
    });
    if (changed) await event({ tenantId: recipient.tenantId, campaignId: recipient.campaignId, recipientId: recipient.id, contactId: recipient.contactId, type: "sent" });
    return;
  }

  const retryStatus = classifyRetry(recipient.attemptCount);
  const temporary = retryStatus === "failed_temporary";
  const delayMinutes = recipient.attemptCount <= 1 ? 5 : 30;
  const changed = await basePrisma.$transaction(async (tx) => {
    const updated = await tx.$executeRaw`
      UPDATE "CampaignRecipient"
      SET "status" = ${retryStatus}, "error" = ${(result.error ?? "send failed").slice(0, 500)},
        "providerStatus" = 'failed',
        "nextAttemptAt" = CASE WHEN ${temporary} THEN CURRENT_TIMESTAMP + (${delayMinutes} * INTERVAL '1 minute') ELSE NULL END
      WHERE "id" = ${recipient.id}
        AND "tenantId" IS NOT DISTINCT FROM ${recipient.tenantId}
        AND "status" = 'sending'
    `;
    if (updated === 1 && !temporary) {
      await tx.$executeRaw`
        UPDATE "Campaign" SET "failedCount" = "failedCount" + 1
        WHERE "id" = ${recipient.campaignId} AND "tenantId" IS NOT DISTINCT FROM ${recipient.tenantId}
      `;
    }
    return updated === 1;
  });
  if (changed) await event({ tenantId: recipient.tenantId, campaignId: recipient.campaignId, recipientId: recipient.id, contactId: recipient.contactId, type: "failed", metadata: { temporary, error: result.error ?? "send failed" } });
}

async function finaliseCampaigns(tenantId: string | null) {
  await basePrisma.$executeRaw`
    UPDATE "Campaign" c SET
      "status" = CASE WHEN c."failedCount" > 0 OR c."suppressedCount" > 0 THEN 'completed_with_errors' ELSE 'completed' END,
      "completedAt" = CURRENT_TIMESTAMP,
      "sentAt" = COALESCE(c."sentAt", CURRENT_TIMESTAMP),
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE c."tenantId" IS NOT DISTINCT FROM ${tenantId}
      AND c."status" IN ('queued', 'sending')
      AND NOT EXISTS (
        SELECT 1 FROM "CampaignRecipient" r
        WHERE r."campaignId" = c."id"
          AND r."tenantId" IS NOT DISTINCT FROM ${tenantId}
          AND r."status" IN ('pending', 'queued', 'sending', 'failed_temporary')
      )
  `;
}

export async function runSafeCampaignQueue(maxTotal = 150) {
  const tenantId = activeTenantId();
  await activateDueCampaigns(tenantId);
  await recoverStaleClaims(tenantId);
  let processed = 0;
  while (processed < maxTotal) {
    const batch = await claimBatch(tenantId, Math.min(BATCH_SIZE, maxTotal - processed));
    if (batch.length === 0) break;
    for (const recipient of batch) await deliver(recipient);
    processed += batch.length;
  }
  await finaliseCampaigns(tenantId);
  return processed;
}
