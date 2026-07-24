"use server";

import { revalidatePath } from "next/cache";
import { getActiveTenantId } from "@/lib/auth";
import { basePrisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { requireModuleEnabled } from "@/lib/modules/enabled";
import { logAuditStrict } from "@/lib/audit";
import { readCampaignDraftRecord } from "@/lib/marketingCampaignDrafts";
import { transitionCampaign } from "@/lib/marketingCampaignWorkflow";

async function operationContext(permission: Parameters<typeof requirePermission>[0]) {
  await requireModuleEnabled("marketing");
  const user = await requirePermission(permission);
  return { user, tenantId: await getActiveTenantId() };
}

async function campaignOrThrow(id: string, tenantId: string | null) {
  const campaign = await readCampaignDraftRecord(id, tenantId);
  if (!campaign) throw new Error("Campaign not found");
  return campaign;
}

export async function pauseCampaign(id: string) {
  const { user, tenantId } = await operationContext("campaigns.pause");
  const campaign = await campaignOrThrow(id, tenantId);
  await transitionCampaign({ campaignId: id, tenantId, from: campaign.status, to: "paused", userId: user.id, userName: user.name });
  await logAuditStrict({ action: "campaign.paused", summary: `Paused campaign “${campaign.name}”`, entityType: "Campaign", entityId: id, user, before: campaign, after: { status: "paused" } });
  revalidatePath(`/marketing/campaigns/${id}`);
}

export async function resumeCampaign(id: string) {
  const { user, tenantId } = await operationContext("campaigns.send");
  const campaign = await campaignOrThrow(id, tenantId);
  await transitionCampaign({ campaignId: id, tenantId, from: campaign.status, to: "queued", userId: user.id, userName: user.name });
  await logAuditStrict({ action: "campaign.resumed", summary: `Resumed campaign “${campaign.name}”`, entityType: "Campaign", entityId: id, user, before: campaign, after: { status: "queued" } });
  revalidatePath(`/marketing/campaigns/${id}`);
}

export async function cancelCampaign(id: string, formData: FormData) {
  const { user, tenantId } = await operationContext("campaigns.cancel");
  const campaign = await campaignOrThrow(id, tenantId);
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) throw new Error("Cancellation reason is required");
  await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE "CampaignRecipient"
      SET "status" = 'cancelled', "providerStatus" = 'campaign_cancelled', "nextAttemptAt" = NULL
      WHERE "campaignId" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
        AND "status" IN ('pending', 'queued', 'failed_temporary')
    `;
    await tx.$executeRaw`
      UPDATE "Campaign" SET "status" = 'cancelled', "cancelledAt" = CURRENT_TIMESTAMP,
        "reviewNote" = ${reason}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
        AND "status" IN ('scheduled', 'queued', 'sending', 'paused')
    `;
  });
  await logAuditStrict({ action: "campaign.cancelled", summary: `Cancelled campaign “${campaign.name}”: ${reason}`, entityType: "Campaign", entityId: id, user, before: campaign, after: { status: "cancelled", reason } });
  revalidatePath(`/marketing/campaigns/${id}`);
}

export async function retryCampaignFailures(id: string) {
  const { user, tenantId } = await operationContext("campaigns.retry");
  const campaign = await campaignOrThrow(id, tenantId);
  if (!new Set(["sending", "completed_with_errors", "failed"]).has(campaign.status)) throw new Error("This campaign has no retryable state");
  const count = await basePrisma.$executeRaw`
    UPDATE "CampaignRecipient"
    SET "status" = 'queued', "error" = NULL, "nextAttemptAt" = CURRENT_TIMESTAMP, "providerStatus" = 'manual_retry'
    WHERE "campaignId" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
      AND "status" = 'failed_temporary'
  `;
  if (count === 0) throw new Error("No temporary failures are eligible for retry");
  await basePrisma.$executeRaw`
    UPDATE "Campaign" SET "status" = 'queued', "completedAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
  `;
  await logAuditStrict({ action: "campaign.recipient_retried", summary: `Queued ${count} temporary campaign failures for retry`, entityType: "Campaign", entityId: id, user, before: campaign, after: { status: "queued", retried: count } });
  revalidatePath(`/marketing/campaigns/${id}`);
}

export async function retryCampaignRecipients(id: string, recipientIds: string[]) {
  const { user, tenantId } = await operationContext("campaigns.retry");
  const uniqueIds = [...new Set(recipientIds)];
  if (uniqueIds.length === 0 || uniqueIds.length > 100) throw new Error("Choose between 1 and 100 recipients");
  await campaignOrThrow(id, tenantId);
  const rows = await basePrisma.$queryRaw<Array<{ id: string; status: string }>>`
    SELECT "id", "status"
    FROM "CampaignRecipient"
    WHERE "tenantId" IS NOT DISTINCT FROM ${tenantId}
      AND "campaignId" = ${id}
      AND "id" = ANY(${uniqueIds}::text[])
      AND "status" IN ('failed_temporary', 'failed_permanent')
    FOR UPDATE
  `;
  if (rows.length === 0) throw new Error("No selected recipients are eligible for retry");
  const permanent = rows.filter((row) => row.status === "failed_permanent").length;
  const allowedIds = rows.map((row) => row.id);
  await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE "CampaignRecipient"
      SET "status" = 'queued', "error" = NULL, "nextAttemptAt" = CURRENT_TIMESTAMP, "providerStatus" = 'manual_retry'
      WHERE "tenantId" IS NOT DISTINCT FROM ${tenantId}
        AND "campaignId" = ${id}
        AND "id" = ANY(${allowedIds}::text[])
        AND "status" IN ('failed_temporary', 'failed_permanent')
    `;
    await tx.$executeRaw`
      UPDATE "Campaign"
      SET "status" = 'queued', "completedAt" = NULL,
        "failedCount" = GREATEST(0, "failedCount" - ${permanent}), "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
    `;
  });
  await logAuditStrict({ action: "campaign.recipient_retried", summary: `Manually queued ${allowedIds.length} campaign recipients for retry`, entityType: "Campaign", entityId: id, user, after: { recipientIds: allowedIds, retried: allowedIds.length } });
  revalidatePath(`/marketing/campaigns/${id}`);
}

export async function archiveCampaign(id: string) {
  const { user, tenantId } = await operationContext("campaigns.archive");
  const campaign = await campaignOrThrow(id, tenantId);
  await transitionCampaign({ campaignId: id, tenantId, from: campaign.status, to: "archived", userId: user.id, userName: user.name });
  await logAuditStrict({ action: "campaign.archived", summary: `Archived campaign “${campaign.name}”`, entityType: "Campaign", entityId: id, user, before: campaign, after: { status: "archived" } });
  revalidatePath("/marketing/campaigns");
}
