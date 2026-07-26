"use server";

import { revalidatePath } from "next/cache";
import { getActiveTenantId } from "@/lib/auth";
import { requirePermission } from "@/lib/permissions";
import { requireModuleEnabled } from "@/lib/modules/enabled";
import { logAuditStrict } from "@/lib/audit";
import { readCampaignDraftRecord } from "@/lib/marketingCampaignDrafts";
import {
  campaignQa,
  freezeAudienceAndQueue,
  transitionCampaign,
  transitionCampaignWithVersion,
} from "@/lib/marketingCampaignWorkflow";

function note(formData?: FormData) {
  return String(formData?.get("note") ?? "").trim() || null;
}

async function context(permission: Parameters<typeof requirePermission>[0]) {
  await requireModuleEnabled("marketing");
  const user = await requirePermission(permission);
  return { user, tenantId: await getActiveTenantId() };
}

export async function submitCampaignForReview(id: string) {
  const { user, tenantId } = await context("campaigns.edit");
  const campaign = await readCampaignDraftRecord(id, tenantId);
  if (!campaign) throw new Error("Campaign not found");
  const issues = await campaignQa(id, tenantId);
  const errors = issues.filter((issue) => issue.severity === "error");
  if (errors.length) throw new Error(errors.map((issue) => issue.message).join("; "));
  const version = await transitionCampaignWithVersion({
    campaignId: id,
    tenantId,
    from: campaign.status,
    to: "in_review",
    userId: user.id,
    userName: user.name,
    reason: "Submitted for review",
  });
  await logAuditStrict({ action: "campaign.submitted", summary: `Submitted campaign “${campaign.name}” version ${version} for review`, entityType: "Campaign", entityId: id, user, before: campaign, after: { status: "in_review", version } });
  revalidatePath(`/marketing/campaigns/${id}/review`);
}

export async function requestCampaignChanges(id: string, formData: FormData) {
  const { user, tenantId } = await context("campaigns.review");
  const campaign = await readCampaignDraftRecord(id, tenantId);
  if (!campaign) throw new Error("Campaign not found");
  const reviewNote = note(formData);
  if (!reviewNote) throw new Error("Explain the required changes");
  await transitionCampaign({ campaignId: id, tenantId, from: campaign.status, to: "changes_requested", userId: user.id, userName: user.name, note: reviewNote });
  await logAuditStrict({ action: "campaign.changes_requested", summary: `Requested changes to campaign “${campaign.name}”`, entityType: "Campaign", entityId: id, user, before: campaign, after: { status: "changes_requested", reviewNote } });
  revalidatePath(`/marketing/campaigns/${id}/review`);
}

export async function approveCampaign(id: string, formData: FormData) {
  const { user, tenantId } = await context("campaigns.approve");
  const campaign = await readCampaignDraftRecord(id, tenantId);
  if (!campaign) throw new Error("Campaign not found");
  const issues = await campaignQa(id, tenantId);
  const errors = issues.filter((issue) => issue.severity === "error");
  if (errors.length) throw new Error(errors.map((issue) => issue.message).join("; "));
  const version = await transitionCampaignWithVersion({
    campaignId: id,
    tenantId,
    from: campaign.status,
    to: "approved",
    userId: user.id,
    userName: user.name,
    reason: "Approved for launch",
    note: note(formData),
  });
  await logAuditStrict({ action: "campaign.approved", summary: `Approved campaign “${campaign.name}” version ${version}`, entityType: "Campaign", entityId: id, user, before: campaign, after: { status: "approved", version } });
  revalidatePath(`/marketing/campaigns/${id}/review`);
}

export async function reopenCampaignDraft(id: string) {
  const { user, tenantId } = await context("campaigns.edit");
  const campaign = await readCampaignDraftRecord(id, tenantId);
  if (!campaign) throw new Error("Campaign not found");
  await transitionCampaign({ campaignId: id, tenantId, from: campaign.status, to: "draft", userId: user.id, userName: user.name });
  await logAuditStrict({ action: "campaign.reopened", summary: `Returned campaign “${campaign.name}” to draft`, entityType: "Campaign", entityId: id, user, before: campaign, after: { status: "draft" } });
  revalidatePath(`/marketing/campaigns/${id}/edit`);
}

export async function scheduleCampaign(id: string, formData: FormData) {
  const { user, tenantId } = await context("campaigns.schedule");
  const raw = String(formData.get("scheduledFor") ?? "").trim();
  if (!raw) throw new Error("Choose a scheduled date and time");
  const scheduledFor = new Date(raw);
  if (Number.isNaN(scheduledFor.getTime())) throw new Error("Invalid scheduled date");
  const campaign = await readCampaignDraftRecord(id, tenantId);
  if (!campaign) throw new Error("Campaign not found");
  const result = await freezeAudienceAndQueue({
    campaignId: id,
    tenantId,
    scheduleFor: scheduledFor,
    userId: user.id,
    userName: user.name,
    reason: "Scheduled with frozen audience",
  });
  await logAuditStrict({ action: "campaign.scheduled", summary: `Scheduled campaign “${campaign.name}” version ${result.version} for ${result.count} recipients`, entityType: "Campaign", entityId: id, user, before: campaign, after: { status: "scheduled", scheduledFor, recipientCount: result.count, version: result.version } });
  revalidatePath(`/marketing/campaigns/${id}/review`);
}

export async function sendApprovedCampaignNow(id: string) {
  const { user, tenantId } = await context("campaigns.send");
  const campaign = await readCampaignDraftRecord(id, tenantId);
  if (!campaign) throw new Error("Campaign not found");
  const result = await freezeAudienceAndQueue({
    campaignId: id,
    tenantId,
    scheduleFor: null,
    userId: user.id,
    userName: user.name,
    reason: "Queued with frozen audience",
  });
  await logAuditStrict({ action: "campaign.queued", summary: `Queued campaign “${campaign.name}” version ${result.version} for ${result.count} recipients`, entityType: "Campaign", entityId: id, user, before: campaign, after: { status: "queued", recipientCount: result.count, version: result.version } });
  revalidatePath(`/marketing/campaigns/${id}/review`);
}
