/**
 * CONTACTS THAT ARE KEPT FOR GOOD (Sean, 2026-11-21): a customer with a sale or filed paperwork is never deleted —
 * not from the contact page, not by the 60-day trash purge — even after the vehicle they bought has changed hands.
 *
 * A sale is any of: a vehicle they own now, a vehicle they owned before (ownership history, undone transfers aside),
 * a won deal, an accepted quote. Filed paperwork is any document on their record that isn't in the trash, anything sent
 * to them for signature, and any document generated for them.
 *
 * Takes the caller's client so the delete action can ask inside its own transaction, with the contact row held.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function contactKeptBecause(db: any, tenantId: string | null, contactId: string): Promise<string | null> {
  const mine = { tenantId, contactId };
  const [vehicles, owned, won, accepted, filed, signed, generated] = await Promise.all([
    db.vehicle.count({ where: { ...mine, deletedAt: null } }),
    db.vehicleOwnership.count({ where: { ...mine, reversedAt: null } }),
    db.lead.count({ where: { ...mine, status: "won", deletedAt: null } }),
    db.quote.count({ where: { ...mine, status: "accepted", deletedAt: null } }),
    db.document.count({ where: { ...mine, deletedAt: null } }),
    // Paperwork sent for signature or generated for them counts too — the purge keeps those records (#1170).
    db.signatureRequest.count({ where: mine }),
    db.docInstance.count({ where: mine }),
  ]);
  const documents = filed + signed + generated;
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);
  const reasons = [
    vehicles > 0 && `owns ${plural(vehicles, "a vehicle", "vehicles")}`,
    vehicles === 0 && owned > 0 && "owned a vehicle before",
    won > 0 && `has ${plural(won, "a won deal", "won deals")}`,
    accepted > 0 && `has ${plural(accepted, "an accepted quote", "accepted quotes")}`,
    documents > 0 && `has ${plural(documents, "a filed document", "filed documents")}`,
  ].filter(Boolean) as string[];
  if (reasons.length === 0) return null;
  const list = reasons.length === 1 ? reasons[0] : `${reasons.slice(0, -1).join(", ")} and ${reasons[reasons.length - 1]}`;
  return `This customer ${list}, so they're kept for good and can't be deleted.`;
}
