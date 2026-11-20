import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { refuse } from "./actionResult";
import { GOVERNANCE_TX, logAuditStrict } from "./audit";
import { contactName } from "./format";
import { getWorkspaceSetting } from "./settings";
import {
  fleetAfterTransfer,
  OWNERSHIP_REASON_LABELS,
  parseOwnershipWarranty,
  parseWarrantyTransferRule,
  transferRefusal,
  undoRefusal,
  warrantyAtTransfer,
  WARRANTY_TRANSFER_KEY,
  type OwnershipReason,
  type OwnershipWarranty,
  type TransferReason,
  type WarrantyTransferRule,
} from "./vehicleTransferRules";

/*
 * Who owned a vehicle when, and the transfer itself (warranty-transfer-brief.md, PR 1). Every query names the
 * workspace. The transfer and its undo are ONE transaction with the vehicle row held FOR UPDATE, every conditional
 * update count-checked, and the audit written on the same transaction — so two transfers at once can't both land,
 * and a transfer that half-happened can't exist. The database's one-open-row index is the backstop.
 *
 * History stays put: services, claims, job cards, battery checks and mileage are never moved or copied. Warranty dates
 * never change. Vehicle.contactId stays the current owner, so everything that reads it is unchanged.
 */

type Actor = { id: string; name: string };

const NAME_SELECT = { id: true, firstName: true, lastName: true, company: true, isCompany: true } as const;

export async function warrantyTransferRule(tenantId: string): Promise<WarrantyTransferRule> {
  return parseWarrantyTransferRule(await getWorkspaceSetting(tenantId, WARRANTY_TRANSFER_KEY).catch(() => null));
}

/** The current owner's row: whether the warranty covers them. "carried" for a vehicle with no row (never expected). */
export async function currentOwnershipWarranty(tenantId: string, vehicleId: string): Promise<OwnershipWarranty> {
  const open = await prisma.vehicleOwnership.findFirst({ where: { tenantId, vehicleId, ownedUntil: null }, select: { warranty: true } });
  return parseOwnershipWarranty(open?.warranty);
}

export type OwnershipEntry = {
  id: string;
  contactId: string | null;
  /** Null once that contact was purged: "Previous owner (deleted)". */
  ownerName: string | null;
  ownedFrom: Date;
  ownedUntil: Date | null;
  reason: OwnershipReason;
  reasonLabel: string;
  odometerKm: number | null;
  note: string | null;
  warranty: OwnershipWarranty;
  transferredByName: string | null;
  createdAt: Date;
  reversedAt: Date | null;
  reversedByName: string | null;
};

/** The vehicle's owners, newest first (staff only — it names every owner). */
export async function ownershipHistory(tenantId: string, vehicleId: string): Promise<OwnershipEntry[]> {
  const rows = await prisma.vehicleOwnership.findMany({
    where: { tenantId, vehicleId },
    orderBy: [{ ownedFrom: "desc" }, { createdAt: "desc" }],
    include: { contact: { select: NAME_SELECT } },
    take: 100,
  });
  return rows.map((row) => {
    const reason = (row.reason in OWNERSHIP_REASON_LABELS ? row.reason : "other") as OwnershipReason;
    return {
      id: row.id,
      contactId: row.contactId,
      ownerName: row.contact ? contactName(row.contact) : null,
      ownedFrom: row.ownedFrom,
      ownedUntil: row.ownedUntil,
      reason,
      reasonLabel: OWNERSHIP_REASON_LABELS[reason],
      odometerKm: row.odometerKm,
      note: row.note,
      warranty: parseOwnershipWarranty(row.warranty),
      transferredByName: row.transferredByName,
      createdAt: row.createdAt,
      reversedAt: row.reversedAt,
      reversedByName: row.reversedByName,
    };
  });
}

/** Vehicles this contact owned before and no longer does (not undone transfers), for "Previously owned". */
export async function previouslyOwnedVehicles(
  tenantId: string,
  contactId: string,
): Promise<{ vehicleId: string; model: string; color: string | null; regNumber: string | null; ownedFrom: Date; ownedUntil: Date }[]> {
  const rows = await prisma.vehicleOwnership.findMany({
    where: {
      tenantId,
      contactId,
      ownedUntil: { not: null },
      reversedAt: null,
      vehicle: { tenantId, deletedAt: null, NOT: { contactId } },
    },
    orderBy: { ownedUntil: "desc" },
    select: { vehicleId: true, ownedFrom: true, ownedUntil: true, vehicle: { select: { model: true, color: true, regNumber: true } } },
    take: 100,
  });
  const seen = new Set<string>();
  return rows
    .filter((row) => !seen.has(row.vehicleId) && seen.add(row.vehicleId))
    .map((row) => ({ vehicleId: row.vehicleId, model: row.vehicle.model, color: row.vehicle.color, regNumber: row.vehicle.regNumber, ownedFrom: row.ownedFrom, ownedUntil: row.ownedUntil! }));
}

export type NewOwnerContact = { firstName: string; lastName: string | null; phone: string | null; email: string | null };

export type TransferInput = {
  tenantId: string;
  vehicleId: string;
  /** An existing contact — or, with `newContact`, "" and the contact is created inside the transfer. */
  newContactId: string;
  newContact?: NewOwnerContact | null;
  date: Date;
  reason: TransferReason;
  odometerKm: number | null;
  note: string | null;
  proofDocumentId: string | null;
  actor: Actor;
  now?: Date;
};

const isOneOpenRowViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

/**
 * Transfer the vehicle. In one transaction: the vehicle held, the current owner's row closed on the transfer date, the
 * new owner's opened, Vehicle.contactId set, the fleet left when the new owner isn't part of it, a mileage reading
 * when an odometer was given, and the audit entry.
 */
export async function transferVehicleOwnership(
  input: TransferInput,
): Promise<{ ownershipId: string; fromContactId: string | null; toContactId: string; warranty: OwnershipWarranty }> {
  const { tenantId, vehicleId, date, reason, odometerKm, note, proofDocumentId, actor } = input;
  const now = input.now ?? new Date();
  const rule = await warrantyTransferRule(tenantId);
  try {
    return await prisma.$transaction(async (tx) => {
      // THE VEHICLE ROW HELD: a second transfer (or an undo) waits here, then reads what this one wrote.
      const held = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Vehicle" WHERE "id" = ${vehicleId} AND "tenantId" = ${tenantId} AND "deletedAt" IS NULL FOR UPDATE`;
      if (held.length !== 1) refuse("This vehicle is in the trash or no longer exists, so it can't be transferred.");
      const vehicle = await tx.vehicle.findFirst({
        where: { id: vehicleId, tenantId, deletedAt: null },
        select: { model: true, contactId: true, fleetId: true },
      });
      if (!vehicle) refuse("This vehicle is in the trash or no longer exists, so it can't be transferred.");
      const open = await tx.vehicleOwnership.findFirst({
        where: { tenantId, vehicleId, ownedUntil: null },
        select: { id: true, ownedFrom: true, warranty: true },
      });
      if (!open) refuse("This vehicle has no ownership record. Refresh the page and try again.");
      // Checked before a new contact is made, so a refused transfer creates nobody (and the transaction rolls back anyway).
      const early = transferRefusal({ newContactId: input.newContact ? "new" : input.newContactId, currentContactId: vehicle.contactId, currentFrom: open.ownedFrom, date, reason, odometerKm, now });
      if (early) refuse(early);
      let newContactId = input.newContactId;
      if (input.newContact) {
        if (!input.newContact.firstName.trim()) refuse("Type the new owner's name.");
        const made = await tx.contact.create({
          data: { ...input.newContact, tenantId, ownerId: actor.id, createdById: actor.id, source: "Vehicle transfer" },
          select: { id: true, firstName: true, lastName: true },
        });
        newContactId = made.id;
        await logAuditStrict({ action: "contact.created", summary: `Created contact ${contactName(made)} as the new owner of ${vehicle.model}`, contactId: made.id, user: actor }, tx);
      }
      const newOwner = await tx.contact.findFirst({ where: { id: newContactId, tenantId, deletedAt: null }, select: { ...NAME_SELECT, fleetId: true } });
      if (!newOwner) refuse("The new owner isn't a contact in this workspace (or is in the trash).");
      const problem = transferRefusal({ newContactId, currentContactId: vehicle.contactId, currentFrom: open.ownedFrom, date, reason, odometerKm, now });
      if (problem) refuse(problem);
      const previous = await tx.contact.findFirst({ where: { id: vehicle.contactId, tenantId }, select: NAME_SELECT });
      const fleet = vehicle.fleetId ? await tx.fleet.findFirst({ where: { id: vehicle.fleetId, tenantId }, select: { id: true, contactId: true } }) : null;
      const fleetId = fleetAfterTransfer(fleet, newOwner);

      const closed = await tx.vehicleOwnership.updateMany({ where: { id: open.id, tenantId, ownedUntil: null }, data: { ownedUntil: date } });
      if (closed.count !== 1) refuse("Someone else changed this vehicle's owner just now. Refresh the page and try again.");
      const warranty = warrantyAtTransfer(rule, reason, parseOwnershipWarranty(open.warranty));
      const created = await tx.vehicleOwnership.create({
        data: {
          tenantId,
          vehicleId,
          contactId: newContactId,
          ownedFrom: date,
          reason,
          odometerKm,
          note,
          proofDocumentId,
          warranty,
          fleetIdBefore: vehicle.fleetId,
          transferredById: actor.id,
          transferredByName: actor.name,
        },
        select: { id: true },
      });
      const moved = await tx.vehicle.updateMany({
        where: { id: vehicleId, tenantId, contactId: vehicle.contactId, deletedAt: null },
        data: { contactId: newContactId, fleetId },
      });
      if (moved.count !== 1) refuse("Someone else changed this vehicle's owner just now. Refresh the page and try again.");
      if (odometerKm != null) {
        await tx.mileageLog.create({ data: { tenantId, vehicleId, km: odometerKm, note: "Odometer at transfer to new owner", recordedAt: date } });
      }
      const fromName = previous ? contactName(previous) : "the previous owner";
      await logAuditStrict(
        {
          action: "vehicle.transferred",
          summary: `Transferred ${vehicle.model} from ${fromName} to ${contactName(newOwner)} on ${date.toISOString().slice(0, 10)} — ${OWNERSHIP_REASON_LABELS[reason]}${warranty === "carried" ? "" : warranty === "pending" ? " (warranty transfer awaiting approval)" : " (warranty did not transfer)"}${fleet && !fleetId ? "; left its fleet" : ""}`,
          contactId: newContactId,
          entityType: "Vehicle",
          entityId: vehicleId,
          before: { contactId: vehicle.contactId, fleetId: vehicle.fleetId },
          after: { contactId: newContactId, fleetId, ownershipId: created.id, reason, warranty },
          user: actor,
        },
        tx,
      );
      return { ownershipId: created.id, fromContactId: vehicle.contactId, toContactId: newContactId, warranty };
    }, GOVERNANCE_TX);
  } catch (error) {
    // The database's one-current-owner rule caught a transfer racing this one.
    if (isOneOpenRowViolation(error)) refuse("Someone else transferred this vehicle just now. Refresh the page to see its owner.");
    throw error;
  }
}

/**
 * Undo the most recent transfer: the reversed row is kept and marked, the previous owner's row reopens, the vehicle
 * goes back to them (and to its old fleet, if that still exists). Refused once the new owner has a claim, job card or
 * service on the vehicle (lib/vehicleTransferRules.ts undoRefusal).
 */
export async function undoLastTransfer(input: { tenantId: string; vehicleId: string; actor: Actor; now?: Date }): Promise<{ toContactId: string }> {
  const { tenantId, vehicleId, actor } = input;
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const held = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Vehicle" WHERE "id" = ${vehicleId} AND "tenantId" = ${tenantId} AND "deletedAt" IS NULL FOR UPDATE`;
    if (held.length !== 1) refuse("This vehicle is in the trash or no longer exists.");
    const vehicle = await tx.vehicle.findFirst({ where: { id: vehicleId, tenantId, deletedAt: null }, select: { model: true, contactId: true, fleetId: true } });
    if (!vehicle) refuse("This vehicle is in the trash or no longer exists.");
    const latest = await tx.vehicleOwnership.findFirst({
      where: { tenantId, vehicleId, ownedUntil: null },
      select: { id: true, contactId: true, ownedFrom: true, reason: true, reversedAt: true, fleetIdBefore: true },
    });
    const previous = latest
      ? await tx.vehicleOwnership.findFirst({
          where: { tenantId, vehicleId, reversedAt: null, ownedUntil: latest.ownedFrom, id: { not: latest.id } },
          orderBy: { createdAt: "desc" },
          select: { id: true, contactId: true },
        })
      : null;
    const since = latest?.ownedFrom ?? now;
    const [claims, jobCards, services] = await Promise.all([
      tx.warrantyClaim.count({ where: { tenantId, vehicleId, claimedAt: { gte: since } } }),
      tx.jobCard.count({ where: { tenantId, vehicleId, deletedAt: null, openedAt: { gte: since } } }),
      tx.serviceRecord.count({ where: { tenantId, vehicleId, serviceDate: { gte: since } } }),
    ]);
    const problem = undoRefusal(latest, previous, { claims, jobCards, services });
    if (problem) refuse(problem);
    const back = previous!.contactId!;
    const reversed = await tx.vehicleOwnership.updateMany({
      where: { id: latest!.id, tenantId, ownedUntil: null },
      data: { ownedUntil: latest!.ownedFrom, reversedAt: now, reversedByName: actor.name },
    });
    if (reversed.count !== 1) refuse("Someone else changed this vehicle's owner just now. Refresh the page and try again.");
    const reopened = await tx.vehicleOwnership.updateMany({ where: { id: previous!.id, tenantId, ownedUntil: latest!.ownedFrom }, data: { ownedUntil: null } });
    if (reopened.count !== 1) refuse("Someone else changed this vehicle's owner just now. Refresh the page and try again.");
    const oldFleet = latest!.fleetIdBefore
      ? await tx.fleet.findFirst({ where: { id: latest!.fleetIdBefore, tenantId, deletedAt: null }, select: { id: true } })
      : null;
    const moved = await tx.vehicle.updateMany({
      where: { id: vehicleId, tenantId, contactId: latest!.contactId ?? vehicle.contactId, deletedAt: null },
      data: { contactId: back, fleetId: oldFleet?.id ?? (latest!.fleetIdBefore ? null : vehicle.fleetId) },
    });
    if (moved.count !== 1) refuse("Someone else changed this vehicle's owner just now. Refresh the page and try again.");
    const [from, to] = await Promise.all([
      latest!.contactId ? tx.contact.findFirst({ where: { id: latest!.contactId, tenantId }, select: NAME_SELECT }) : null,
      tx.contact.findFirst({ where: { id: back, tenantId }, select: NAME_SELECT }),
    ]);
    await logAuditStrict(
      {
        action: "vehicle.transfer_undone",
        summary: `Undid the transfer of ${vehicle.model} to ${from ? contactName(from) : "the new owner"}; it is ${to ? contactName(to) : "the previous owner"}'s again`,
        contactId: back,
        entityType: "Vehicle",
        entityId: vehicleId,
        before: { contactId: vehicle.contactId, ownershipId: latest!.id },
        after: { contactId: back, ownershipId: previous!.id },
        user: actor,
      },
      tx,
    );
    return { toContactId: back };
  }, GOVERNANCE_TX);
}

/** Whether the latest transfer may be undone right now — null, or why not (the same rule the undo itself applies). */
export async function undoBlockedBecause(tenantId: string, vehicleId: string): Promise<string | null> {
  const latest = await prisma.vehicleOwnership.findFirst({
    where: { tenantId, vehicleId, ownedUntil: null },
    select: { id: true, ownedFrom: true, reason: true, reversedAt: true },
  });
  if (!latest || latest.reason === "registered") return "There's no transfer to undo.";
  const previous = await prisma.vehicleOwnership.findFirst({
    where: { tenantId, vehicleId, reversedAt: null, ownedUntil: latest.ownedFrom, id: { not: latest.id } },
    orderBy: { createdAt: "desc" },
    select: { contactId: true },
  });
  const [claims, jobCards, services] = await Promise.all([
    prisma.warrantyClaim.count({ where: { tenantId, vehicleId, claimedAt: { gte: latest.ownedFrom } } }),
    prisma.jobCard.count({ where: { tenantId, vehicleId, deletedAt: null, openedAt: { gte: latest.ownedFrom } } }),
    prisma.serviceRecord.count({ where: { tenantId, vehicleId, serviceDate: { gte: latest.ownedFrom } } }),
  ]);
  return undoRefusal(latest, previous, { claims, jobCards, services });
}

/** Approve or decline a pending warranty transfer for the current owner. */
export async function decideWarrantyTransfer(input: { tenantId: string; vehicleId: string; approve: boolean; actor: Actor }): Promise<void> {
  const { tenantId, vehicleId, approve, actor } = input;
  await prisma.$transaction(async (tx) => {
    const open = await tx.vehicleOwnership.findFirst({
      where: { tenantId, vehicleId, ownedUntil: null },
      select: { id: true, warranty: true, contactId: true, vehicle: { select: { model: true } } },
    });
    if (!open || open.warranty !== "pending") refuse("There's no warranty transfer waiting for approval on this vehicle.");
    const decided = await tx.vehicleOwnership.updateMany({
      where: { id: open.id, tenantId, ownedUntil: null, warranty: "pending" },
      data: { warranty: approve ? "carried" : "not_carried" },
    });
    if (decided.count !== 1) refuse("Someone else decided this just now. Refresh the page.");
    await logAuditStrict(
      {
        action: approve ? "vehicle.warranty_transfer_approved" : "vehicle.warranty_transfer_declined",
        summary: `${approve ? "Approved" : "Declined"} the warranty transfer on ${open.vehicle.model} for its new owner`,
        contactId: open.contactId,
        entityType: "Vehicle",
        entityId: vehicleId,
        user: actor,
      },
      tx,
    );
  }, GOVERNANCE_TX);
}
