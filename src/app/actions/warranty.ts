"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { customerRecordTenantId } from "@/lib/customerRecordTenant";
import { resolveTenantActor } from "@/lib/tenantActor";
import { logAudit } from "@/lib/audit";
import { sendEmail } from "@/lib/email";
import { sendSms } from "@/lib/sms";
import { tenantEmailContent, tenantSmsContent } from "@/lib/signing/signingEmail";
import { describeBlockedReason, firstAllowedChannel } from "@/lib/communicationPolicy";
import { claimStatuses } from "@/lib/warranty";
import { requirePermission, requireVehicleAccess } from "@/lib/permissions";
import { withActingStaffScope } from "@/lib/actingScope";
import { asActionResult, refuse } from "@/lib/actionResult";
import { requiredReason } from "@/lib/deleteReason";

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

export async function deleteWarrantyClaim(id: string, formData?: FormData) {
  return asActionResult(async () => {
    // Authorise before answering anything about the record.
    await requirePermission("warranty.manage");
    const claim = await prisma.warrantyClaim.findUnique({ where: { id } });
    if (!claim) refuse("That warranty claim is already gone — refresh the page.");
    const user = await requireVehicleAccess(claim.vehicleId, "warranty.manage");
    const reason = requiredReason(formData, "deleting this claim");
    await prisma.warrantyClaim.delete({ where: { id } });
    // Permanent (no Trash for claims), so the audit line is the only record left.
    await logAudit({
      action: "warranty.claim_deleted",
      summary: `Deleted a ${claim.status} warranty claim (“${claim.description.slice(0, 80)}”) — ${reason}`,
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
  return asActionResult(async () => {
    const user = await requirePermission("warranty.manage");
    const recall = await prisma.recall.findUnique({ where: { id }, select: { title: true, model: true } });
    if (!recall) refuse("That recall is already gone — refresh the page.");
    const reason = requiredReason(formData, "deleting this recall");
    await prisma.recall.delete({ where: { id } });
    await logAudit({
      action: "recall.deleted",
      summary: `Deleted the recall “${recall.title}” (${recall.model}) — ${reason}`,
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

    const seen = new Set<string>();
    let sent = 0;
    let skipped = 0;
    for (const v of vehicles) {
      const c = v.contact;
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      // The workspace's own editable "Recall notice" email / SMS (Settings → Email templates).
      const recallVars = {
        first_name: c.firstName,
        recipient_name: [c.firstName, c.lastName].filter(Boolean).join(" "),
        model: recall.model,
        recall_title: recall.title,
        recall_description: recall.description,
      };
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
      let body: string;
      if (verdict.channel === "email") {
        const message = await tenantEmailContent("recall", c.tenantId, recallVars);
        body = message.text;
        ok = (await sendEmail({ to: verdict.destination, subject: message.subject, text: message.text, html: message.html })).ok;
      } else {
        body = await tenantSmsContent("recall_sms", c.tenantId, recallVars);
        ok = (await sendSms(verdict.destination, body)).ok;
      }
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
