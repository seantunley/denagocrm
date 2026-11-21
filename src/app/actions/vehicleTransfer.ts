"use server";

import { revalidatePath } from "next/cache";
import { asActionResult, refuse } from "@/lib/actionResult";
import { withActingStaffScope } from "@/lib/actingScope";
import { getActiveTenantId, requireTenantOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { putWorkspaceSetting } from "@/lib/settings";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { hasPermission, requireContactAccess, requireVehicleAccess } from "@/lib/permissions";
import { decideWarrantyTransfer, transferVehicleOwnership, undoLastTransfer } from "@/lib/vehicleOwnership";
import { sendEmail } from "@/lib/email";
import { sendSms } from "@/lib/sms";
import { tenantEmailContent, tenantSmsContent } from "@/lib/signing/signingEmail";
import { describeBlockedReason, firstAllowedChannel } from "@/lib/communicationPolicy";
import {
  coverRemaining,
  isTransferReason,
  parseOwnershipWarranty,
  parseWarrantyTransferRule,
  transferDay,
  WARRANTY_TRANSFER_KEY,
  WARRANTY_TRANSFER_LABELS,
} from "@/lib/vehicleTransferRules";

/*
 * Transfer a vehicle to a new owner (warranty-transfer-brief.md, PR 1). Who: vehicles.transfer, plus access to the
 * vehicle AND to the destination contact — as updateVehicle checks them. The work is lib/vehicleOwnership.ts.
 */

const text = (formData: FormData, key: string, max: number) => String(formData.get(key) ?? "").trim().slice(0, max);

async function tenant(): Promise<string> {
  const tenantId = await getActiveTenantId();
  if (!tenantId) return refuse("No workspace attached to this sign-in — sign out and back in.");
  return tenantId;
}

function revalidate(vehicleId: string, ...contactIds: (string | null | undefined)[]) {
  revalidatePath(`/vehicles/${vehicleId}`);
  revalidatePath("/vehicles");
  revalidatePath("/warranty");
  for (const id of contactIds) if (id) revalidatePath(`/contacts/${id}`);
}

export async function transferVehicle(vehicleId: string, formData: FormData) {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      const user = await requireVehicleAccess(vehicleId, "vehicles.transfer");
      const tenantId = await tenant();
      const creating = formData.get("ownerMode") === "new";
      const newContactId = creating ? "" : text(formData, "contactId", 64);
      if (creating) {
        if (!(await hasPermission(user, "contacts.create"))) refuse("You can't create contacts. Choose an existing contact as the new owner.");
      } else {
        if (!newContactId) refuse("Choose the new owner.");
        // The destination customer must be one this person may open, as for any change of a vehicle's customer.
        await requireContactAccess(newContactId, "vehicles.transfer");
      }
      const date = transferDay(text(formData, "date", 10));
      if (!date) refuse("Choose the transfer date.");
      const reason = text(formData, "reason", 40);
      if (!isTransferReason(reason)) refuse("Choose why the vehicle is changing hands.");
      const km = text(formData, "odometerKm", 12);
      const odometerKm = km ? Number(km) : null;
      // A proof document must be one already on this vehicle.
      const proofId = text(formData, "proofDocumentId", 64);
      const proof = proofId
        ? await prisma.document.findFirst({ where: { id: proofId, tenantId, vehicleId, deletedAt: null }, select: { id: true } })
        : null;
      if (proofId && !proof) refuse("That proof document isn't on this vehicle any more. Refresh and choose again.");
      const result = await transferVehicleOwnership({
        tenantId,
        vehicleId,
        newContactId,
        // The owner the dialog showed: a vehicle transferred by someone else meanwhile is refused, not moved on.
        expectedOwnerId: text(formData, "currentOwnerId", 64) || null,
        newContact: creating
          ? {
              firstName: text(formData, "firstName", 80),
              lastName: text(formData, "lastName", 80) || null,
              phone: text(formData, "phone", 40) || null,
              email: text(formData, "email", 160).toLowerCase() || null,
            }
          : null,
        date,
        reason,
        odometerKm,
        note: text(formData, "note", 1000) || null,
        proofDocumentId: proof?.id ?? null,
        actor: { id: user.id, name: user.name },
      });
      revalidate(vehicleId, result.fromContactId, result.toContactId);
      // Warranty module off: no warranty wording.
      if (!(await isModuleEnabled("warranty"))) return { success: "Transferred. The vehicle's history went with it." };
      return {
        success:
          result.warranty === "carried"
            ? "Transferred. The warranty and the vehicle's history went with it."
            : result.warranty === "pending"
              ? "Transferred. The warranty transfer is waiting for approval."
              : "Transferred. Under this workspace's rule the warranty did not transfer.",
      };
    }),
  );
}

export async function undoVehicleTransfer(vehicleId: string) {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      const user = await requireVehicleAccess(vehicleId, "vehicles.transfer");
      const tenantId = await tenant();
      const { toContactId } = await undoLastTransfer({ tenantId, vehicleId, actor: { id: user.id, name: user.name } });
      revalidate(vehicleId, toContactId);
      return { success: "Transfer undone. The vehicle is back with its previous owner." };
    }),
  );
}

export async function decideVehicleWarrantyTransfer(vehicleId: string, formData: FormData) {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      const user = await requireVehicleAccess(vehicleId, "warranty.manage");
      const tenantId = await tenant();
      const approve = formData.get("decision") === "approve";
      await decideWarrantyTransfer({ tenantId, vehicleId, approve, actor: { id: user.id, name: user.name } });
      revalidate(vehicleId);
      return { success: approve ? "Approved: the warranty now covers the new owner." : "Declined: the warranty does not cover the new owner." };
    }),
  );
}

/**
 * Welcome the vehicle's NEW owner (PR 3) — only when someone presses Send, never automatically. The workspace's own
 * editable "Welcome to a vehicle's new owner" email (or SMS when they can't be emailed), through the same consent
 * check as every service message; logged on the new owner's timeline.
 */
export async function sendVehicleWelcome(vehicleId: string) {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      const user = await requireVehicleAccess(vehicleId, "vehicles.transfer");
      const tenantId = await tenant();
      const vehicle = await prisma.vehicle.findFirst({
        where: { id: vehicleId, tenantId, deletedAt: null },
        select: {
          model: true, purchaseDate: true, warrantyMonths: true, warrantyParts: true, warrantyStartsAt: true,
          contact: { select: { id: true, firstName: true, lastName: true } },
        },
      });
      if (!vehicle) return refuse("This vehicle is in the trash or no longer exists.");
      const open = await prisma.vehicleOwnership.findFirst({ where: { tenantId, vehicleId, ownedUntil: null }, select: { reason: true, contactId: true, warranty: true } });
      if (!open || open.reason === "registered" || open.contactId !== vehicle.contact.id) refuse("There's no new owner to welcome on this vehicle.");
      const c = vehicle.contact;
      const warranty = parseOwnershipWarranty(open!.warranty);
      const vars = {
        first_name: c.firstName,
        recipient_name: [c.firstName, c.lastName].filter(Boolean).join(" "),
        model: vehicle.model,
        // The Warranty module off: the message says nothing about a warranty.
        warranty_line: !(await isModuleEnabled("warranty"))
          ? ""
          : warranty === "carried" ? `Warranty: ${coverRemaining(vehicle)}.` : warranty === "pending" ? "We'll confirm its warranty with you shortly." : "",
      };
      const verdict = await firstAllowedChannel({ contactId: c.id, tenantId, purpose: "service", channels: ["email", "sms"] });
      if (!verdict.allowed || !verdict.destination) {
        await logAudit({ action: "communication.suppressed", summary: `Welcome to the new owner of ${vehicle.model} not sent — ${describeBlockedReason(verdict.reason)}`, contactId: c.id, user });
        return refuse(`Not sent: ${describeBlockedReason(verdict.reason)}.`);
      }
      let body: string;
      let ok: boolean;
      if (verdict.channel === "email") {
        const message = await tenantEmailContent("vehicle_welcome", tenantId, vars);
        body = message.text;
        ok = (await sendEmail({ to: verdict.destination, subject: message.subject, text: message.text, html: message.html })).ok;
      } else {
        body = await tenantSmsContent("vehicle_welcome_sms", tenantId, vars);
        ok = (await sendSms(verdict.destination, body)).ok;
      }
      if (!ok) refuse("The message didn't send. Check the email and SMS settings, then try again.");
      await prisma.communication.create({
        data: { type: verdict.channel === "email" ? "email" : "sms", direction: "outbound", subject: `Welcome — ${vehicle.model}`, body, contactId: c.id, userId: user.id, tenantId },
      });
      await logAudit({ action: "vehicle.welcome_sent", summary: `Sent the new owner a welcome for ${vehicle.model} (${verdict.channel})`, contactId: c.id, entityType: "Vehicle", entityId: vehicleId, user });
      revalidate(vehicleId, c.id);
      return { success: `Welcome sent by ${verdict.channel === "email" ? "email" : "SMS"}` };
    }),
  );
}

/** The workspace's rule for the warranty on a transfer (decision 1 of the brief). Owner only. */
export async function saveWarrantyTransferRule(formData: FormData) {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      const user = await requireTenantOwner();
      if (!(await isModuleEnabled("warranty"))) refuse("The Warranty module is off for this workspace.");
      const tenantId = await tenant();
      const rule = parseWarrantyTransferRule(text(formData, "rule", 20));
      await putWorkspaceSetting(tenantId, WARRANTY_TRANSFER_KEY, rule);
      await logAudit({ action: "settings.warranty_transfer_rule", summary: `Warranty on vehicle transfer: ${WARRANTY_TRANSFER_LABELS[rule]}`, user });
      revalidatePath("/warranty");
      return { success: "Saved" };
    }),
  );
}
