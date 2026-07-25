"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { getActiveTenantId } from "@/lib/auth";
import { requirePermission, requireContactAccess } from "@/lib/permissions";
import { sendEmail } from "@/lib/email";
import { saveFile } from "@/lib/storage";
import {
  resolveContacts,
  buildTrackedEmail,
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
  await requirePermission("campaigns.edit");
  const file = formData.get("file") as File | null;
  if (!file || !file.type.startsWith("image/")) return null;
  if (file.size > 5 * 1024 * 1024) return null;
  const buf = Buffer.from(await file.arrayBuffer());
  return saveFile(buf, file.name, file.type);
}

export async function previewAudience(formData: FormData): Promise<{ count: number }> {
  await requirePermission("campaigns.edit");
  const channel = str(formData.get("channel")) || "email";
  const { criteria } = await criteriaFor(formData);
  return { count: (await resolveContacts(criteria, channel)).length };
}

export async function sendCampaignTest(
  _prev: CampaignState | undefined,
  formData: FormData
): Promise<CampaignState> {
  await requirePermission("campaigns.test_send");
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

/**
 * Compatibility action retained for the legacy Campaigns screen.
 *
 * Direct launch from a web request is deliberately retired. Creating recipients,
 * bypassing approval and calling a provider from this action would defeat the
 * governed campaign state machine and atomic queue introduced under /marketing.
 */
export async function sendCampaign(
  _prev: CampaignState | undefined,
  _formData: FormData
): Promise<CampaignState> {
  await requirePermission("campaigns.create");
  return {
    error: "Direct campaign launch has been retired. Create a governed draft in Marketing → Campaigns, submit it for review, approve it, then schedule or queue it.",
  };
}

export async function saveSegment(formData: FormData) {
  await requirePermission("campaigns.edit");
  const name = str(formData.get("name"));
  if (!name) return;
  await prisma.segment.create({
    data: { name, criteria: JSON.stringify(criteriaFromForm(formData)) },
  });
  revalidatePath("/campaigns");
  revalidatePath("/marketing/audiences");
}

export async function deleteSegment(id: string) {
  await requirePermission("campaigns.edit");
  // Tenant-qualified delete. The db.ts guard is dormant until enforcement is on,
  // so a bare delete-by-id would let someone with a known cross-tenant segment id
  // delete another tenant's segment. Resolve the active tenant and scope the
  // delete to it explicitly; deleteMany + an affected-row check makes a
  // non-matching id/tenant a no-op rather than a silent success.
  const tenantId = await getActiveTenantId();
  const { count } = await prisma.segment.deleteMany({ where: { id, tenantId } });
  if (count === 0) throw new Error("Segment not found");
  revalidatePath("/campaigns");
  revalidatePath("/marketing/audiences");
}

export async function setMarketingOptOut(contactId: string, optOut: boolean) {
  await requireContactAccess(contactId, "campaigns.manage");
  await prisma.contact.update({ where: { id: contactId }, data: { marketingOptOut: optOut } });
  revalidatePath("/campaigns");
  revalidatePath("/marketing/campaigns");
}
