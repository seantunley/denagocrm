"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { customerRecordTenantId } from "@/lib/customerRecordTenant";
import { resolveTenantActor } from "@/lib/tenantActor";
import { logAudit } from "@/lib/audit";
import { sendEmail } from "@/lib/email";
import { sendSms } from "@/lib/sms";
import { companyContactPhrase, getCompanyProfile } from "@/lib/companyProfile";
import { describeBlockedReason, firstAllowedChannel } from "@/lib/communicationPolicy";
import { claimStatuses } from "@/lib/warranty";
import { requirePermission, requireVehicleAccess } from "@/lib/permissions";
import { withActingStaffScope } from "@/lib/actingScope";

export async function addWarrantyClaim(vehicleId: string, formData: FormData) {
  return withActingStaffScope(async () => {
    const user = await requireVehicleAccess(vehicleId, "warranty.manage");
    const description = String(formData.get("description") ?? "").trim();
    if (!description) throw new Error("Describe the fault");
    const vehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
    await prisma.warrantyClaim.create({
      data: { vehicleId, contactId: vehicle.contactId, description, createdById: user.id },
    });
    await logAudit({
      action: "warranty.claim.opened",
      summary: `Opened a warranty claim on ${vehicle.model}`,
      contactId: vehicle.contactId,
      user,
    });
    revalidatePath(`/vehicles/${vehicleId}`);
    revalidatePath("/warranty");
  });
}

export async function setWarrantyClaimStatus(id: string, formData: FormData) {
  return withActingStaffScope(async () => {
    const existing = await prisma.warrantyClaim.findUniqueOrThrow({ where: { id } });
    const user = await requireVehicleAccess(existing.vehicleId, "warranty.manage");
    const status = String(formData.get("status") ?? "");
    if (!claimStatuses.includes(status as (typeof claimStatuses)[number])) return;
    const resolution = String(formData.get("resolution") ?? "").trim() || null;
    const claim = await prisma.warrantyClaim.update({
      where: { id },
      data: {
        status,
        resolution,
        resolvedAt: status === "resolved" || status === "rejected" ? new Date() : null,
      },
    });
    await logAudit({
      action: "warranty.claim.updated",
      summary: `Warranty claim marked ${status}`,
      contactId: claim.contactId ?? undefined,
      user,
    });
    revalidatePath(`/vehicles/${claim.vehicleId}`);
    revalidatePath("/warranty");
  });
}

/** The reason typed into the delete confirmation, for the audit line. */
const reasonOf = (formData?: FormData) => String(formData?.get("reason") ?? "").trim() || "No reason given";

export async function deleteWarrantyClaim(id: string, formData?: FormData) {
  return withActingStaffScope(async () => {
    const claim = await prisma.warrantyClaim.findUnique({ where: { id } });
    if (!claim) return;
    const user = await requireVehicleAccess(claim.vehicleId, "warranty.manage");
    await prisma.warrantyClaim.delete({ where: { id } });
    // Permanent (no Trash for claims), so the audit line is the only record left.
    await logAudit({
      action: "warranty.claim_deleted",
      summary: `Deleted a ${claim.status} warranty claim (“${claim.description.slice(0, 80)}”) — ${reasonOf(formData)}`,
      contactId: claim.contactId,
      user,
    });
    revalidatePath(`/vehicles/${claim.vehicleId}`);
    revalidatePath("/warranty");
  });
}

export async function createRecall(formData: FormData) {
  return withActingStaffScope(async () => {
    const user = await requirePermission("warranty.manage");
    const title = String(formData.get("title") ?? "").trim();
    const model = String(formData.get("model") ?? "").trim();
    const description = String(formData.get("description") ?? "").trim();
    if (!title || !model || !description) throw new Error("Title, model and details are required");
    await prisma.recall.create({ data: { title, model, description, createdById: user.id } });
    await logAudit({ action: "recall.created", summary: `Created recall/bulletin "${title}" for ${model}`, user });
    revalidatePath("/warranty");
  });
}

export async function deleteRecall(id: string, formData?: FormData) {
  return withActingStaffScope(async () => {
    const user = await requirePermission("warranty.manage");
    const recall = await prisma.recall.findUnique({ where: { id }, select: { title: true, model: true } });
    if (!recall) return;
    await prisma.recall.delete({ where: { id } });
    await logAudit({
      action: "recall.deleted",
      summary: `Deleted the recall “${recall.title}” (${recall.model}) — ${reasonOf(formData)}`,
      user,
    });
    revalidatePath("/warranty");
  });
}

export type NotifyResult = { sent: number; skipped: number } | null;

export async function notifyRecall(_prev: NotifyResult, formData: FormData): Promise<NotifyResult> {
  return withActingStaffScope(async () => {
    const user = await requirePermission("warranty.manage");
    const id = String(formData.get("recallId") ?? "");
    const recall = await prisma.recall.findUniqueOrThrow({ where: { id } });
    const vehicles = await prisma.vehicle.findMany({
      where: { model: recall.model },
      include: { contact: true },
    });
    const firstUser = await resolveTenantActor();
    const company = await getCompanyProfile();
    const contactPhrase = companyContactPhrase(company);

    const seen = new Set<string>();
    let sent = 0;
    let skipped = 0;
    for (const v of vehicles) {
      const c = v.contact;
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const first = c.firstName;
      const subject = `Important: ${recall.title} — your ${recall.model}`;
      const body = `Hi ${first},\n\n${recall.description}\n\nPlease contact ${contactPhrase} to arrange this at no charge.\n\nWarm regards,\n${company.name}`;
      // Trashed contacts, portal service switches and withdrawn service consent.
      const verdict = await firstAllowedChannel({
        contactId: c.id,
        tenantId: c.tenantId,
        purpose: "service",
        channels: ["email", "sms"],
      });
      if (!verdict.allowed || !verdict.destination) {
        skipped += 1;
        await logAudit({
          action: "communication.suppressed",
          summary: `Recall notice "${recall.title}" not sent — ${describeBlockedReason(verdict.reason)}`,
          contactId: c.id,
          user,
        });
        continue;
      }
      let ok = false;
      if (verdict.channel === "email") ok = (await sendEmail({ to: verdict.destination, subject, text: body })).ok;
      else ok = (await sendSms(verdict.destination, `${recall.title}: ${recall.description} Call ${contactPhrase}.`)).ok;
      if (!ok) {
        skipped += 1;
        continue;
      }
      sent += 1;
      if (firstUser) {
        await prisma.communication.create({
          data: {
            type: verdict.channel === "email" ? "email" : "sms",
            direction: "outbound",
            subject: `[Recall] ${recall.title}`,
            body,
            contactId: c.id,
            userId: firstUser.id,
            tenantId: await customerRecordTenantId({ contactId: c.id }),
          },
        });
      }
    }
    await prisma.recall.update({ where: { id }, data: { notifiedAt: new Date() } });
    await logAudit({ action: "recall.notified", summary: `Notified ${sent} owner(s) about "${recall.title}"`, user });
    revalidatePath("/warranty");
    return { sent, skipped };
  });
}
