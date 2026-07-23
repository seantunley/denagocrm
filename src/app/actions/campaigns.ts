"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission, requireContactAccess } from "@/lib/permissions";
import { sendEmail, isSmtpConfigured } from "@/lib/email";
import { isSmsConfigured } from "@/lib/sms";
import { saveFile } from "@/lib/storage";
import { logAudit } from "@/lib/audit";
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

async function criteriaFor(formData: FormData): Promise<{ criteria: SegmentCriteria; label: string }> {
  const segmentId = str(formData.get("segmentId"));
  if (segmentId) {
    const seg = await prisma.segment.findUnique({ where: { id: segmentId } });
    if (seg) return { criteria: JSON.parse(seg.criteria), label: seg.name };
  }
  const criteria = criteriaFromForm(formData);
  return { criteria, label: await audienceLabel(criteria) };
}

async function audienceLabel(cr: SegmentCriteria): Promise<string> {
  const parts: string[] = [];
  if (cr.source) parts.push(`source: ${cr.source}`);
  if (cr.tagId) parts.push(`tag: ${(await prisma.tag.findUnique({ where: { id: cr.tagId } }))?.name ?? "?"}`);
  if (cr.province) parts.push(cr.province);
  if (cr.hasVehicle) parts.push("cart owners");
  if (cr.serviceDue) parts.push("service due");
  if (cr.wonOnly) parts.push("customers");
  return parts.length ? parts.join(" · ") : "All customers";
}

export async function uploadCampaignImage(formData: FormData): Promise<string | null> {
  await requirePermission("campaigns.manage");
  const file = formData.get("file") as File | null;
  if (!file || !file.type.startsWith("image/")) return null;
  if (file.size > 5 * 1024 * 1024) return null;
  const buf = Buffer.from(await file.arrayBuffer());
  return saveFile(buf, file.name, file.type);
}

export async function previewAudience(formData: FormData): Promise<{ count: number }> {
  await requirePermission("campaigns.manage");
  const channel = str(formData.get("channel")) || "email";
  const { criteria } = await criteriaFor(formData);
  return { count: (await resolveContacts(criteria, channel)).length };
}

export async function sendCampaignTest(
  _prev: CampaignState | undefined,
  formData: FormData
): Promise<CampaignState> {
  await requirePermission("campaigns.manage");
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
  formData: FormData
): Promise<CampaignState> {
  const user = await requirePermission("campaigns.manage");
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

  const { criteria, label } = await criteriaFor(formData);
  const contacts = await resolveContacts(criteria, channel);
  if (contacts.length === 0) return { error: "No opted-in recipients match that audience." };

  const campaign = await prisma.campaign.create({
    data: {
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
  try {
    // Flat child writes are required by the tenant guard: nested relation writes
    // cannot be tenant-stamped safely while composite tenant FKs are staged.
    await prisma.campaignRecipient.createMany({
      data: contacts.map((contact) => ({
        campaignId: campaign.id,
        contactId: contact.id,
        token: newToken(),
      })),
    });
  } catch (error) {
    await prisma.campaign.delete({ where: { id: campaign.id } }).catch(() => {});
    throw error;
  }

  await sendCampaignBatch(campaign.id, 60);
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
  await requirePermission("campaigns.manage");
  const name = str(formData.get("name"));
  if (!name) return;
  await prisma.segment.create({
    data: { name, criteria: JSON.stringify(criteriaFromForm(formData)) },
  });
  revalidatePath("/campaigns");
}

export async function deleteSegment(id: string) {
  await requirePermission("campaigns.manage");
  await prisma.segment.delete({ where: { id } });
  revalidatePath("/campaigns");
}

export async function setMarketingOptOut(contactId: string, optOut: boolean) {
  // requireContactAccess enforces campaigns.manage AND access to THIS contact, so
  // a scoped manager can't flip marketing consent on a contact outside their
  // scope — a POPIA consent-integrity concern. (Was: permission only, any id.)
  await requireContactAccess(contactId, "campaigns.manage");
  await prisma.contact.update({ where: { id: contactId }, data: { marketingOptOut: optOut } });
  revalidatePath("/campaigns");
}
