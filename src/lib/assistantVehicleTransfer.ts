import "server-only";
import type { z } from "zod";
import { prisma } from "./db";
import { logAudit } from "./audit";
import { contactName, formatDate } from "./format";
import { canAccessContact, canAccessVehicle, hasPermission, type PermissionUser } from "./permissions";
import { isModuleEnabled } from "./modules/enabled";
import { transferVehicleOwnership, warrantyTransferRule } from "./vehicleOwnership";
import { coverRemaining, OWNERSHIP_REASON_LABELS, transferDay, transferRefusal, warrantyAtTransfer, type TransferReason } from "./vehicleTransferRules";
import type { ActionCard, proposedAction } from "./assistantActions";

/*
 * DAX PROPOSES A VEHICLE TRANSFER (warranty-transfer-brief.md, PR 3): "Thandi sold her Nomad to Sipho on the 3rd" →
 * a card showing the vehicle, both owners, the date, the reason and what happens to the warranty; Confirm runs the
 * transfer's own core (lib/vehicleOwnership.ts) — one transaction, audited, the history and warranty dates untouched.
 * Never sends anything to anyone. The owner the card showed must still be the owner at Confirm.
 */

export const VEHICLE_TRANSFER_RULE =
  '- transfer_vehicle: when they say a customer\'s vehicle has CHANGED HANDS ("Thandi sold her Nomad to Sipho on the 3rd", "move the cart to his company"). {"type":"transfer_vehicle","vehicleId":"<id>","contactId":"<the NEW owner\'s contactId>","date":"YYYY-MM-DD","because":"sold_privately|traded_in|inherited|company_change|correction|other","odometerKm":12345,"note":"..."}. ' +
  "vehicleId from the vehicles lookup (kind customer) and contactId of the new owner from customers — both must be in the results; never invent one, and if the new owner isn't a customer yet, propose create_customer first and say so. " +
  "If the customer has more than one vehicle and what they said does not single one out, ASK WHICH. date: the day it changed hands (today if they don't say; never in the future). because: correction only when they say the owner was simply entered wrongly. " +
  "To see who owned a vehicle when, use vehicles kind ownership. Confirming moves the vehicle to the new owner with a record; its history and warranty dates stay as they are, and nobody is contacted.";

type Proposal = Extract<z.infer<typeof proposedAction>, { type: "transfer_vehicle" }>;
export type TransferCard = Extract<ActionCard, { kind: "transfer_vehicle" }>;

/** The card, or why DAX can't propose it — every check the transfer itself will make, made now. */
export async function buildTransferCard(user: PermissionUser, p: Proposal, index: number): Promise<{ card: TransferCard } | { problem: string }> {
  if (!(await isModuleEnabled("automotive"))) return { problem: "Vehicles are part of the Automotive module, which is off for this workspace." };
  if (!(await hasPermission(user, "vehicles.transfer"))) return { problem: "Your role can't transfer vehicles." };
  const vehicle = (await canAccessVehicle(user, p.vehicleId))
    ? await prisma.vehicle.findFirst({
        where: { id: p.vehicleId, deletedAt: null },
        select: { id: true, model: true, regNumber: true, tenantId: true, contactId: true, purchaseDate: true, warrantyMonths: true, contact: { select: { firstName: true, lastName: true, company: true, isCompany: true } } },
      })
    : null;
  if (!vehicle?.tenantId) return { problem: "I can't find that vehicle among the ones you can open — look the customer's vehicles up and ask again." };
  const buyer = (await canAccessContact(user, p.contactId))
    ? await prisma.contact.findFirst({ where: { id: p.contactId, deletedAt: null }, select: { id: true, firstName: true, lastName: true, company: true, isCompany: true } })
    : null;
  if (!buyer) return { problem: "I can't find the new owner among the customers you can open — add them first, or look them up and ask again." };
  const date = transferDay(p.date);
  if (!date) return { problem: "That transfer date isn't a date — say which day it changed hands." };
  const open = await prisma.vehicleOwnership.findFirst({ where: { tenantId: vehicle.tenantId, vehicleId: vehicle.id, ownedUntil: null }, select: { ownedFrom: true, warranty: true } });
  const problem = transferRefusal({ newContactId: buyer.id, currentContactId: vehicle.contactId, currentFrom: open?.ownedFrom ?? new Date(0), date, reason: p.because, odometerKm: p.odometerKm ?? null, now: new Date() });
  if (problem) return { problem };
  const rule = await warrantyTransferRule(vehicle.tenantId);
  const warranty = warrantyAtTransfer(rule, p.because as TransferReason, open?.warranty === "not_carried" || open?.warranty === "pending" ? open.warranty : "carried");
  const seller = contactName(vehicle.contact);
  const newOwner = contactName(buyer);
  const what = `${vehicle.model}${vehicle.regNumber ? ` (${vehicle.regNumber})` : ""}`;
  return {
    card: {
      id: `a${index}-${vehicle.id}`,
      kind: "transfer_vehicle",
      leadId: null,
      leadLabel: newOwner,
      title: `Transfer ${what} from ${seller} to ${newOwner}`,
      vehicleId: vehicle.id,
      fromContactId: vehicle.contactId,
      toContactId: buyer.id,
      date: p.date,
      because: p.because as TransferReason,
      ...(p.odometerKm != null ? { odometerKm: p.odometerKm } : {}),
      ...(p.note ? { note: p.note } : {}),
      detail: [
        `On ${formatDate(date)} · ${OWNERSHIP_REASON_LABELS[p.because as TransferReason]}`,
        ...(p.odometerKm != null ? [`Odometer: ${p.odometerKm.toLocaleString()} km`] : []),
        `Warranty: ${coverRemaining(vehicle)} — ${warranty === "carried" ? "transfers to the new owner" : warranty === "pending" ? "waits for approval" : "does not transfer (this workspace's rule)"}`,
        "The vehicle's history stays with it. Nobody is contacted.",
      ].join("\n"),
      ...(p.reason ? { reason: p.reason } : {}),
    },
  };
}

/** Confirm: the transfer's own core, refused if the vehicle has changed hands since the card was shown. */
export async function confirmTransferCard(user: PermissionUser, card: TransferCard): Promise<{ ok: true; success: string; href: string } | { ok: false; error: string }> {
  if (!(await isModuleEnabled("automotive"))) return { ok: false, error: "Vehicles are part of the Automotive module, which is off for this workspace." };
  if (!(await hasPermission(user, "vehicles.transfer")) || !(await canAccessVehicle(user, card.vehicleId)) || !(await canAccessContact(user, card.toContactId))) {
    return { ok: false, error: "You can't transfer that vehicle to that customer any more." };
  }
  const vehicle = await prisma.vehicle.findFirst({ where: { id: card.vehicleId, deletedAt: null }, select: { tenantId: true, contactId: true } });
  if (!vehicle?.tenantId) return { ok: false, error: "That vehicle is no longer there." };
  // A second Confirm of the same card: done already, nothing is written again.
  if (vehicle.contactId === card.toContactId) return { ok: true, success: "Already transferred — nothing was changed twice.", href: `/vehicles/${card.vehicleId}` };
  const date = transferDay(card.date);
  if (!date) return { ok: false, error: "That transfer date isn't a date — ask again." };
  try {
    await transferVehicleOwnership({
      tenantId: vehicle.tenantId,
      vehicleId: card.vehicleId,
      newContactId: card.toContactId,
      expectedOwnerId: card.fromContactId,
      date,
      reason: card.because,
      odometerKm: card.odometerKm ?? null,
      note: card.note ?? null,
      proofDocumentId: null,
      actor: { id: user.id, name: user.name },
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The transfer didn't go through — try it on the vehicle's page." };
  }
  await logAudit({
    action: "assistant.action_confirmed",
    summary: "Confirmed the assistant's proposal: transfer a vehicle to a new owner",
    user,
    contactId: card.toContactId,
    metadata: { kind: card.kind, vehicleId: card.vehicleId },
  });
  return { ok: true, success: "Transferred. The vehicle's history went with it; nobody was contacted.", href: `/vehicles/${card.vehicleId}` };
}
