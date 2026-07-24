"use server";

import { revalidatePath } from "next/cache";
import { basePrisma, prisma } from "@/lib/db";
import { requirePermission, requireContactAccess } from "@/lib/permissions";
import { sendEmail, isSmtpConfigured } from "@/lib/email";
import { isSmsConfigured } from "@/lib/sms";
import { saveFile } from "@/lib/storage";
import { logAudit } from "@/lib/audit";
import { resolveActingTenant } from "@/lib/tenantContext";
import {
  resolveContacts,
  sendCampaignBatch,
  buildTrackedEmail,
  newToken,
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
  const user = await requirePermission("campaigns.manage");
  if (!(await tenantIdFor(user.id))) return null;
  const file = formData.get("file") as File | null;
  if (!file || !file.type.startsWith("image/")) return null;
  if (file.size > 5 * 1024 * 1024) return null;
  const buf = Buffer.from(await file.arrayBuffer());
  return saveFile(buf, file.name, file.type);
}

export async function previewAudience(formData: FormData): Promise<{ count: number }> {
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
}

export async function sendCampaignTest(
  _prev: CampaignState | undefined,
  formData: FormData,
): Promise<CampaignState> {
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
}

export async function sendCampaign(
  _prev: CampaignState | undefined,
  formData: FormData,
): Promise<CampaignState> {
  const user = await requirePermission("campaigns.manage");
  const tenantId = await tenantIdFor(user.id);
  if (!tenantId) return { error: "No active tenant is available." };
  const name = str(formData.get("name"));
  const channel = str(formData.get("channel")) || "email";
  const subject = str(formData.get("subject"));
  const htmlBody = str(formData.get("htmlBody"));
  const smsBody = str(formData.get("body"));
  if (!name) return { error: "Give the campaign a name." };
  if (channel === "email" && !subject) return { error: "Email needs a subject." };
  if (channel === "email" && !htmlBody) return { error: "Write the email." };
  if (channel === "sms" && !smsBody) return { error: "Write the message." };
  if (channel === "email" && !(await isSmtpConfigured()))
    return { error: "Email isn't configured (Settings → Email)." };
  if (channel === "sms" && !(await isSmsConfigured()))
    return { error: "SMS isn't configured (Settings → Integrations)." };

  let criteriaAndLabel: { criteria: SegmentCriteria; label: string };
  try {
    criteriaAndLabel = await criteriaFor(formData, tenantId);
  } catch {
    return { error: "That audience is not available in this tenant." };
  }
  const { criteria, label } = criteriaAndLabel;
  const contacts = await resolveContacts(tenantId, criteria, channel);
  if (contacts.length === 0) return { error: "No opted-in recipients match that audience." };

  const campaign = await basePrisma.$transaction(async (tx) => {
    const created = await tx.campaign.create({
      data: {
        tenantId,
        name,
        channel,
        subject: channel === "email" ? subject : null,
        body: channel === "email" ? htmlToText(htmlBody) : smsBody,
        htmlBody: channel === "email" ? htmlBody : null,
        audience: label,
        recipientCount: contacts.length,
        status: "queued",
        createdById: user.id,
      },
    });
    await tx.campaignRecipient.createMany({
      data: contacts.map((contact) => ({
        tenantId,
        campaignId: created.id,
        contactId: contact.id,
        token: newToken(),
      })),
    });
    return created;
  });

  await sendCampaignBatch(campaign.id, tenantId, 60);
  await logAudit({
    action: "campaign.started",
    summary: `Campaign "${name}" (${channel}) started — ${contacts.length} recipients`,
    user,
  });
  revalidatePath("/campaigns");
  return {
    ok: `Campaign started — sending to ${contacts.length} recipient${contacts.length === 1 ? "" : "s"}. Progress shows below.`,
  };
}

export async function saveSegment(formData: FormData) {
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
}

export async function deleteSegment(id: string) {
  const user = await requirePermission("campaigns.manage");
  const tenantId = await tenantIdFor(user.id);
  if (!tenantId) return;
  await prisma.segment.deleteMany({ where: { id, tenantId } });
  revalidatePath("/campaigns");
}

export async function setMarketingOptOut(contactId: string, optOut: boolean) {
  const user = await requireContactAccess(contactId, "campaigns.manage");
  const tenantId = await tenantIdFor(user.id);
  if (!tenantId) return;
  await prisma.contact.updateMany({
    where: { id: contactId, tenantId },
    data: { marketingOptOut: optOut },
  });
  revalidatePath("/campaigns");
}
