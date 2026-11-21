/**
 * Who sees what of a vehicle's history after it changes hands (warranty-transfer-brief.md, PR 2). Pure.
 *
 * - The NEW OWNER (in the portal): the vehicle, its warranty, the services and claims from their own ownership onward,
 *   and earlier services as date and odometer only — never the previous owner's name, contact details, invoices,
 *   prices, or anything typed on their services.
 * - The PREVIOUS OWNER: loses the vehicle from the transfer (Vehicle.contactId moves); keeps what is theirs.
 * - STAFF: everything, with the owner at the time named on each record.
 *
 * Documents are decided in SQL (lib/portalAccess.ts) by the same dates, so the list and the download agree.
 */

/** The current owner's ownership as the portal reads it. The first owner ("registered") has no cut-off. */
export type OwnershipStart = { ownedFrom: Date; reason: string };

/** From when the current owner's own history runs: null = all of it (the vehicle never changed hands). */
export function historyFrom(current: OwnershipStart | null | undefined): Date | null {
  return current && current.reason !== "registered" ? current.ownedFrom : null;
}

export type PortalService = { id: string; serviceDate: Date; summary: string; km: number | null };
/** A service from before the new owner's time: when, and the odometer. Nothing typed — see splitServices. */
export type EarlierService = { id: string; serviceDate: Date; km: number | null };

/**
 * A new owner's service history: theirs with its summary; earlier ones as the date and odometer ONLY. The summary is
 * free text staff typed for the previous owner — it can hold their name, number or a price — so it never reaches the
 * buyer (review of #1168). The portal never shows a service's notes, technician, job card or price, before or after.
 */
export function splitServices<T extends { id: string; serviceDate: Date; summary: string; km: number | null }>(
  records: readonly T[],
  from: Date | null,
): { own: PortalService[]; earlier: EarlierService[] } {
  const strip = (r: T): PortalService => ({ id: r.id, serviceDate: r.serviceDate, summary: r.summary, km: r.km });
  if (!from) return { own: records.map(strip), earlier: [] };
  return {
    own: records.filter((r) => r.serviceDate >= from).map(strip),
    earlier: records.filter((r) => r.serviceDate < from).map((r) => ({ id: r.id, serviceDate: r.serviceDate, km: r.km })),
  };
}

/** A new owner's warranty claims: only those from their own ownership onward (an earlier claim is the previous owner's). */
export function claimsSince<T extends { claimedAt: Date }>(claims: readonly T[], from: Date | null): T[] {
  return from ? claims.filter((c) => c.claimedAt >= from) : [...claims];
}

/**
 * Who owned the vehicle on a date (staff view): the owner whose ownership covers it, undone transfers ignored. The
 * first owner covers everything before them, so a record dated before the purchase date still has an owner.
 */
export function ownerAt<E extends { ownerName: string | null; ownedFrom: Date; ownedUntil: Date | null; reason: string; reversedAt: Date | null }>(
  entries: readonly E[],
  date: Date,
): string | null {
  const live = entries.filter((e) => !e.reversedAt);
  const covering = live.find((e) => (e.reason === "registered" || e.ownedFrom <= date) && (!e.ownedUntil || date < e.ownedUntil));
  if (!covering) return null;
  return covering.ownerName ?? "Previous owner (deleted)";
}
