"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission, requireContactAccess } from "@/lib/permissions";
import { sendEmail } from "@/lib/email";
import { saveFile } from "@/lib/storage";
import { resolveActingTenant } from "@/lib/tenantContext";
import { withActingStaffScope } from "@/lib/actingScope";
import {
  resolveContacts,
  buildTrackedEmail,
  htmlToText,
  type SegmentCriteria,
} from "@/lib/campaigns";

export type CampaignState = { ok?: string; error?: string };
const str = (v: FormDataEntryValue | null) => String(v ?? "").trim();

async function tenantIdFor(userId: string): Promise<string | null> {
  const tenant = await resolveActingTenant(userId);
  return "tenantId" in tenant ? tenant.tenantId : null;
}

function criteriaFromForm(formData: FormData): SegmentCriteria {
  return {
    source: str(formData.get("f_source")) || undefined,
    tagId: str(formData.get("f_tagId")) || undefined,
    province: str(formData.get("f_province")) || undefined,
    hasVehicle: formData.get("f_hasVehicle") === "on",
    serviceDue: formData.get("f_serviceDue") === "on",
    wonOnly: formData.get("f_wonOnly") === "on",
  };
}

async function criteriaFor(
  formData: FormData,
  tenantId: string,
): Promise<{ criteria: SegmentCriteria; label: string }> {
  const segmentId = str(formData.get("segmentId"));
  if (segmentId) {
    const segment = await prisma.segment.findFirst({ where: { id: segmentId, tenantId } });
    if (!segment) throw new Error("INVALID_CAMPAIGN_SEGMENT");
    return { criteria: JSON.parse(segment.criteria), label: segment.name };
  }
  const criteria = criteriaFromForm(formData);
  return { criteria, label: await audienceLabel(criteria, tenantId) };
}

async function audienceLabel(criteria: SegmentCriteria, tenantId: string): Promise<string> {
  const parts: string[] = [];
  if (criteria.source) parts.push(`source: ${criteria.source}`);
  if (criteria.tagId) {
    const tag = await prisma.tag.findFirst({ where: { id: criteria.tagId, tenantId } });
    parts.push(`tag: ${tag?.name ?? "?"}`);
  }
  if (criteria.province) parts.push(criteria.province);
  if (criteria.hasVehicle) parts.push("cart owners");
  if (criteria.serviceDue) parts.push("service due");
  if (criteria.wonOnly) parts.push("customers");
  return parts.length ? parts.join(" · ") : "All customers";
}

export async function uploadCampaignImage(formData: FormData): Promise<string | null> {
  return withActingStaffScope(async () => {
    const user = await requirePermission("campaigns.manage");
    // A campaign image is uploaded from the composer BEFORE any campaign exists, so
    // there is no parent record to inherit from — the workspace the author is acting
    // in owns it. That workspace was already resolved and REQUIRED here (the action
    // refuses without one), so namespacing costs nothing and invents nothing.
    const tenantId = await tenantIdFor(user.id);
    if (!tenantId) return null;
    const file = formData.get("file") as File | null;
    if (!file || !file.type.startsWith("image/")) return null;
    if (file.size > 5 * 1024 * 1024) return null;
    const buf = Buffer.from(await file.arrayBuffer());
    return saveFile(buf, file.name, file.type, tenantId);
  });
}

export async function previewAudience(formData: FormData): Promise<{ count: number }> {
  return withActingStaffScope(async () => {
    const user = await requirePermission("campaigns.manage");
    const tenantId = await tenantIdFor(user.id);
    if (!tenantId) return { count: 0 };
    const channel = str(formData.get("channel")) || "email";
    try {
      const { criteria } = await criteriaFor(formData, tenantId);
      return { count: (await resolveContacts(tenantId, criteria, channel)).length };
    } catch {
      return { count: 0 };
    }
  });
}

export async function sendCampaignTest(
  _prev: CampaignState | undefined,
  formData: FormData,
): Promise<CampaignState> {
  return withActingStaffScope(async () => {
    const user = await requirePermission("campaigns.manage");
    if (!(await tenantIdFor(user.id))) return { error: "No active tenant is available." };
    const channel = str(formData.get("channel")) || "email";
    const to = str(formData.get("testTo"));
    if (!to) return { error: "Enter a test address / number." };
    const vars = "there";
    if (channel === "email") {
      const subject = str(formData.get("subject")).replace(/\{\{\s*(first_name|name)\s*\}\}/g, vars) || "Test";
      const html = str(formData.get("htmlBody")).replace(/\{\{\s*(first_name|name)\s*\}\}/g, vars);
      if (!html) return { error: "Write the email first." };
      const res = await sendEmail({
        to,
        subject,
        text: htmlToText(html),
        html: buildTrackedEmail(html, "preview"),
      });
      return res.ok ? { ok: `Test email sent to ${to}.` } : { error: res.error ?? "Send failed." };
    }
    const body = str(formData.get("body")).replace(/\{\{\s*(first_name|name)\s*\}\}/g, vars);
    if (!body) return { error: "Write the message first." };
    const { sendSms } = await import("@/lib/sms");
    const res = await sendSms(to, body);
    return res.ok ? { ok: `Test SMS sent to ${to}.` } : { error: res.error ?? "Send failed." };
  });
}

/**
 * Compatibility action retained for the legacy Campaigns screen.
 *
 * Direct launch from a web request is deliberately retired: creating recipients
 * and calling a provider straight from this action would bypass the governed
 * campaign state machine, consent checks and atomic queue introduced under
 * /marketing. Campaigns are now drafted, approved and queued there instead.
 */
export async function sendCampaign(
  _prev: CampaignState | undefined,
  _formData: FormData,
): Promise<CampaignState> {
  return withActingStaffScope(async () => {
    await requirePermission("campaigns.manage");
    return {
      error:
        "Direct campaign launch has been retired. Create a governed draft in Marketing → Campaigns, submit it for review, approve it, then schedule or queue it.",
    };
  });
}

export async function saveSegment(formData: FormData) {
  return withActingStaffScope(async () => {
    const user = await requirePermission("campaigns.manage");
    const tenantId = await tenantIdFor(user.id);
    if (!tenantId) return;
    const name = str(formData.get("name"));
    if (!name) return;
    const criteria = criteriaFromForm(formData);
    if (criteria.tagId) {
      const tagExists = await prisma.tag.count({ where: { id: criteria.tagId, tenantId } });
      if (!tagExists) return;
    }
    await prisma.segment.create({
      data: { tenantId, name, criteria: JSON.stringify(criteria) },
    });
    revalidatePath("/campaigns");
  });
}

export async function deleteSegment(id: string) {
  return withActingStaffScope(async () => {
    const user = await requirePermission("campaigns.manage");
    const tenantId = await tenantIdFor(user.id);
    if (!tenantId) return;
    await prisma.segment.deleteMany({ where: { id, tenantId } });
    revalidatePath("/campaigns");
  });
}

export async function setMarketingOptOut(contactId: string, optOut: boolean) {
  return withActingStaffScope(async () => {
    const user = await requireContactAccess(contactId, "campaigns.manage");
    const tenantId = await tenantIdFor(user.id);
    if (!tenantId) return;
    await prisma.contact.updateMany({
      where: { id: contactId, tenantId },
      data: { marketingOptOut: optOut },
    });
    revalidatePath("/campaigns");
  });
}
