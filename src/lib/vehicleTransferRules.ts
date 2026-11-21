/**
 * Transferring a vehicle and its warranty to a new owner (warranty-transfer-brief.md, 2026-11-20). Pure: the reasons,
 * what a transfer may be, what happens to the fleet and the warranty, and when the last transfer may be undone. The
 * action is app/actions/vehicleTransfer.ts; the store lib/vehicleOwnership.ts.
 *
 * "Transfer the warranty" means "transfer the vehicle to a new owner, with a record": the warranty is two fields on the
 * vehicle (purchaseDate, warrantyMonths), and they never change on a transfer.
 */
import { addMonths, differenceInCalendarDays, differenceInCalendarMonths, startOfDay } from "date-fns";
import { formatDate } from "./format";
import { coverSummary, parseTerms, vehicleCover } from "./warrantyParts";

/** Why it changed hands. `registered` is the first owner (when the vehicle was added) — never chosen on a transfer. */
export const TRANSFER_REASONS = ["sold_privately", "traded_in", "inherited", "company_change", "correction", "other"] as const;
export type TransferReason = (typeof TRANSFER_REASONS)[number];
export type OwnershipReason = TransferReason | "registered";

export const OWNERSHIP_REASON_LABELS: Record<OwnershipReason, string> = {
  registered: "First owner",
  sold_privately: "Sold privately",
  traded_in: "Traded in",
  inherited: "Inherited",
  company_change: "Company change",
  correction: "Correction of a data-entry mistake",
  other: "Other",
};

export const isTransferReason = (value: unknown): value is TransferReason => TRANSFER_REASONS.includes(value as TransferReason);

/**
 * WARRANTY ON TRANSFER — the workspace's rule (decision 1 of the brief, still open with the manufacturer): the warranty
 * passes with the vehicle (yes), stays behind (no), or waits for someone with warranty.manage to approve it. Unset is
 * "yes". It never changes the warranty's dates; it decides whether this owner is covered by them.
 */
export const WARRANTY_TRANSFER_KEY = "WARRANTY_TRANSFER_RULE";
export const WARRANTY_TRANSFER_RULES = ["yes", "no", "approval"] as const;
export type WarrantyTransferRule = (typeof WARRANTY_TRANSFER_RULES)[number];
export const WARRANTY_TRANSFER_LABELS: Record<WarrantyTransferRule, string> = {
  yes: "Yes — the warranty transfers with the vehicle",
  no: "No — the warranty stays with the first owner",
  approval: "Needs approval — someone with warranty rights approves each transfer",
};
export const parseWarrantyTransferRule = (value: string | null | undefined): WarrantyTransferRule =>
  WARRANTY_TRANSFER_RULES.includes(value as WarrantyTransferRule) ? (value as WarrantyTransferRule) : "yes";

/** Whether an owner is covered by the vehicle's warranty dates. */
export type OwnershipWarranty = "carried" | "not_carried" | "pending";
export const OWNERSHIP_WARRANTY_LABELS: Record<OwnershipWarranty, string> = {
  carried: "Warranty transferred",
  not_carried: "Warranty did not transfer",
  pending: "Warranty transfer awaiting approval",
};
export const parseOwnershipWarranty = (value: string | null | undefined): OwnershipWarranty =>
  value === "not_carried" || value === "pending" ? value : "carried";

/**
 * What the new owner's warranty is, at transfer. A correction fixes who owned it all along, so it keeps what the
 * mistaken row had; any real change of hands follows the workspace's rule.
 */
export function warrantyAtTransfer(rule: WarrantyTransferRule, reason: TransferReason, current: OwnershipWarranty): OwnershipWarranty {
  if (reason === "correction") return current;
  return rule === "yes" ? "carried" : rule === "no" ? "not_carried" : "pending";
}

/** A claim may be logged only for an owner the warranty covers. Null = fine; otherwise why not. */
export function claimRefusal(warranty: OwnershipWarranty): string | null {
  if (warranty === "not_carried") return "The warranty didn't transfer to this owner, so a warranty claim can't be logged for them.";
  if (warranty === "pending") return "This owner's warranty transfer is waiting for approval. Approve it on the vehicle's Ownership panel first.";
  return null;
}

/** The day a transfer takes effect, from the form ("YYYY-MM-DD"), as the start of that day. Null when not a date. */
export function transferDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const day = new Date(`${value}T00:00:00`);
  return Number.isNaN(day.getTime()) ? null : day;
}

export type TransferCheck = {
  newContactId: string;
  currentContactId: string | null;
  /** When the current ownership began. */
  currentFrom: Date;
  date: Date;
  reason: unknown;
  odometerKm: number | null;
  now: Date;
};

/** Why a transfer can't happen, or null. One rule for the dialog and the server. */
export function transferRefusal(t: TransferCheck): string | null {
  if (!t.newContactId) return "Choose the new owner.";
  if (t.newContactId === t.currentContactId) return "That contact already owns this vehicle.";
  if (!isTransferReason(t.reason)) return "Choose why the vehicle is changing hands.";
  if (startOfDay(t.date) > startOfDay(t.now)) return "The transfer date can't be in the future.";
  if (startOfDay(t.date) < startOfDay(t.currentFrom)) return "The transfer date can't be before the current owner took over.";
  if (t.odometerKm != null && (!Number.isInteger(t.odometerKm) || t.odometerKm < 0 || t.odometerKm > 2_000_000)) return "The odometer reading isn't a number of km.";
  return null;
}

/**
 * The fleet after a transfer: kept only when the new owner is part of that fleet (its manager, or a contact in it).
 * A vehicle sold out of a golf estate's fleet leaves the fleet; one moving between people of the same company stays.
 */
export function fleetAfterTransfer(fleet: { id: string; contactId: string | null } | null, newOwner: { id: string; fleetId: string | null }): string | null {
  if (!fleet) return null;
  return fleet.contactId === newOwner.id || newOwner.fleetId === fleet.id ? fleet.id : null;
}

/** The new owner's activity on the vehicle since they took over — any of it means the transfer is no longer undone. */
export type ActivitySince = { claims: number; jobCards: number; services: number };

/**
 * Whether the latest transfer may be undone, or why not. Only a real transfer (not the first owner), only while the
 * person it was undone back to still exists, and only before the new owner has a claim, job card or service.
 */
export function undoRefusal(latest: { reason: string; reversedAt: Date | null } | null, previous: { contactId: string | null } | null, activity: ActivitySince): string | null {
  if (!latest || latest.reason === "registered" || latest.reversedAt) return "There's no transfer to undo.";
  if (!previous) return "There's no earlier owner to go back to.";
  if (!previous.contactId) return "The previous owner has been deleted, so the transfer can't be undone. Transfer it again instead.";
  const done = [
    activity.claims ? `${activity.claims} warranty claim${activity.claims === 1 ? "" : "s"}` : "",
    activity.jobCards ? `${activity.jobCards} job card${activity.jobCards === 1 ? "" : "s"}` : "",
    activity.services ? `${activity.services} service${activity.services === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return done.length
    ? `The new owner already has ${done.join(", ")} on this vehicle, so the transfer can't be undone. If the transfer was a mistake, transfer it back with the reason "Correction".`
    : null;
}

/** "14 months and 3 days of cover left", "Out of warranty since 2 Mar 2026", or that there's no warranty on record. */
export function coverRemaining(
  v: { purchaseDate: Date | null; warrantyMonths: number | null; warrantyParts?: unknown; warrantyStartsAt?: Date | null },
  now = new Date(),
): string {
  // A vehicle with its warranty in parts (lib/warrantyParts.ts): each part's cover, "Chassis Lifetime" included.
  if (parseTerms(v.warrantyParts).length > 0 && v.warrantyStartsAt) {
    return coverSummary(vehicleCover({ ...v, warrantyParts: v.warrantyParts, warrantyStartsAt: v.warrantyStartsAt }, now), (d) => formatDate(d));
  }
  if (!v.purchaseDate || !v.warrantyMonths) return "No warranty on record";
  const expiry = addMonths(v.purchaseDate, v.warrantyMonths);
  if (differenceInCalendarDays(expiry, now) < 0) return `Out of warranty since ${formatDate(expiry)}`;
  const months = Math.max(0, differenceInCalendarMonths(expiry, now) - (addMonths(now, differenceInCalendarMonths(expiry, now)) > expiry ? 1 : 0));
  const days = differenceInCalendarDays(expiry, addMonths(now, months));
  const parts = [months ? `${months} month${months === 1 ? "" : "s"}` : "", days ? `${days} day${days === 1 ? "" : "s"}` : ""].filter(Boolean);
  return `${parts.join(" and ") || "Less than a day"} of cover left (until ${formatDate(expiry)})`;
}
