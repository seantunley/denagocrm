import "server-only";
import { basePrisma } from "@/lib/db";
import {
  requireJobCardAccess,
  requireQuoteAccess,
  requireVehicleAccess,
} from "@/lib/permissions";
import { hostById, type HostDef } from "./hosts";

/**
 * The database half of the host registry.
 *
 * ./hosts.ts says which hosts exist, what permission each needs and which module
 * owns it. This says "and does that record actually exist, in this tenant?" —
 * the part that needs Prisma, which is exactly why it is a separate file: the
 * catalogue stays importable by `node --test`, and a guard fails the build if
 * the two ever stop agreeing about which hosts there are.
 *
 * ── THIS IS THE ONLY DOOR ───────────────────────────────────────────────────
 *
 * A run addresses its subject by `hostType` + `hostId`, which no foreign key can
 * constrain. Every path that creates a run, edits one, or issues an upload token
 * for one of its photos goes through `requireChecklistHostAccess` first. Two
 * things must hold and neither is sufficient alone:
 *
 *   1. The caller holds the permission the HOST demands — the same key the
 *      record's own screen demands. A checklist must never become a way to
 *      attach evidence to a record you could not otherwise touch.
 *   2. The record exists AND belongs to the acting tenant. Checked here rather
 *      than trusted from the payload, because `hostId` arrives from a phone.
 */

export type ResolvedHost = { host: HostDef; hostId: string };

/**
 * A deliberately small, flat set of host facts available to item visibility
 * rules. These are presentation rules, never access control; the host gate must
 * have run before this helper is called.
 */
export async function checklistHostSignals(
  hostType: string,
  hostId: string,
  tenantId: string,
): Promise<Record<string, unknown>> {
  const host = hostById(hostType);
  if (!host) throw new Error("That checklist target is not something this app knows about.");
  switch (host.model) {
    case "quote": {
      const row = await basePrisma.quote.findFirst({
        where: { id: hostId, tenantId, deletedAt: null },
        select: { status: true, invoicedAt: true, depositPaidAt: true, deliveryScheduledFor: true, deliveredAt: true, fleetId: true },
      });
      if (!row) throw new Error("That quote is not available in the active workspace.");
      return { ...row, hasFleet: Boolean(row.fleetId) };
    }
    case "jobCard": {
      const row = await basePrisma.jobCard.findFirst({
        where: { id: hostId, tenantId, deletedAt: null },
        select: { status: true, priority: true, underWarranty: true, isSubcontracted: true, kmIn: true, vehicleId: true },
      });
      if (!row) throw new Error("That job card is not available in the active workspace.");
      return row;
    }
    case "vehicle": {
      const row = await basePrisma.vehicle.findFirst({
        where: { id: hostId, tenantId, deletedAt: null },
        select: { model: true, color: true, vin: true, regNumber: true, warrantyMonths: true, serviceIntervalKm: true },
      });
      if (!row) throw new Error("That vehicle is not available in the active workspace.");
      return { ...row, hasVin: Boolean(row.vin), hasRegistration: Boolean(row.regNumber) };
    }
    default:
      throw new Error("That checklist target has no resolver.");
  }
}

/**
 * Authorise a host record, or throw.
 *
 * Throws rather than returning a boolean deliberately: every caller is a
 * privileged write, and a `false` that somebody forgets to check is a silent
 * hole. The `require*Access` helpers this delegates to already throw, so the
 * shape is the one the rest of the codebase already uses.
 */
export async function requireChecklistHostAccess(
  hostType: string,
  hostId: string,
  tenantId: string | null,
): Promise<ResolvedHost> {
  const host = hostById(hostType);
  // An unknown host string is not a 404 to be shrugged at — it means a payload
  // named something this build does not have, and the safe reading is refusal.
  if (!host) throw new Error("That checklist target is not something this app knows about.");
  if (!tenantId) throw new Error("No active workspace.");

  switch (host.model) {
    case "quote": {
      await requireQuoteAccess(hostId, host.permission);
      const row = await basePrisma.quote.findFirst({
        where: { id: hostId, tenantId, deletedAt: null },
        select: { id: true },
      });
      // Soft-deleted records are excluded here as well as by the permission
      // helper: a quote in the Trash must not gain new evidence, because the
      // whole point of deleting it was that it stops being worked on.
      if (!row) throw new Error("That quote is not available in the active workspace.");
      break;
    }
    case "jobCard": {
      await requireJobCardAccess(hostId, host.permission);
      const row = await basePrisma.jobCard.findFirst({
        where: { id: hostId, tenantId, deletedAt: null },
        select: { id: true },
      });
      if (!row) throw new Error("That job card is not available in the active workspace.");
      break;
    }
    case "vehicle": {
      await requireVehicleAccess(hostId, host.permission);
      const row = await basePrisma.vehicle.findFirst({
        where: { id: hostId, tenantId, deletedAt: null },
        select: { id: true },
      });
      if (!row) throw new Error("That vehicle is not available in the active workspace.");
      break;
    }
    default: {
      // Unreachable while `HostDef.model` is a closed union — and checked anyway,
      // because a host added to the catalogue without a resolver here would
      // otherwise fall through this switch and be authorised by nothing at all.
      throw new Error("That checklist target has no resolver.");
    }
  }

  return { host, hostId };
}
