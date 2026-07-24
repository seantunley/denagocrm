"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getActiveTenantId } from "@/lib/auth";
import { requirePermission } from "@/lib/permissions";
import { logAuditStrict } from "@/lib/audit";
import {
  createCampaignDraftRecord,
  readCampaignDraftRecord,
  updateCampaignDraftRecord,
} from "@/lib/marketingCampaignDrafts";

function formObject(formData: FormData): Record<string, unknown> {
  return Object.fromEntries(formData.entries());
}

export async function createCampaignDraft(formData?: FormData) {
  const user = await requirePermission("campaigns.create");
  const tenantId = await getActiveTenantId();
  const id = await createCampaignDraftRecord({ tenantId, userId: user.id, input: formData ? formObject(formData) : {} });
  await logAuditStrict({
    action: "campaign.created",
    summary: "Created campaign draft",
    entityType: "Campaign",
    entityId: id,
    user,
    after: { id, status: "draft" },
  });
  redirect(`/marketing/campaigns/${id}/edit`);
}

export async function updateCampaignDraft(id: string, formData: FormData) {
  const user = await requirePermission("campaigns.edit");
  const tenantId = await getActiveTenantId();
  const before = await readCampaignDraftRecord(id, tenantId);
  if (!before) throw new Error("Campaign not found");
  await updateCampaignDraftRecord({ id, tenantId, input: formObject(formData) });
  const after = await readCampaignDraftRecord(id, tenantId);
  await logAuditStrict({
    action: "campaign.updated",
    summary: `Updated campaign draft “${after?.name ?? before.name}”`,
    entityType: "Campaign",
    entityId: id,
    user,
    before,
    after,
  });
  revalidatePath(`/marketing/campaigns/${id}/edit`);
  revalidatePath("/marketing/campaigns");
}

export async function duplicateCampaignDraft(id: string) {
  const user = await requirePermission("campaigns.create");
  const tenantId = await getActiveTenantId();
  const source = await readCampaignDraftRecord(id, tenantId);
  if (!source) throw new Error("Campaign not found");
  const copyId = await createCampaignDraftRecord({
    tenantId,
    userId: user.id,
    input: { ...source, name: `${source.name} — copy` },
  });
  await logAuditStrict({
    action: "campaign.duplicated",
    summary: `Duplicated campaign “${source.name}”`,
    entityType: "Campaign",
    entityId: copyId,
    user,
    after: { id: copyId, sourceId: id, status: "draft" },
  });
  redirect(`/marketing/campaigns/${copyId}/edit`);
}
