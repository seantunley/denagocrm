import { basePrisma } from "./db";

/**
 * CONTACTS THAT ARE KEPT FOR GOOD (Sean, 2026-11-21): a customer with a sale or filed paperwork is never deleted —
 * not from the contact page, not by the 60-day trash purge — even after the vehicle they bought has changed hands, so
 * the chain of documents stays valid.
 *
 * A sale is any of: a vehicle they own now, a vehicle they owned before (ownership history, undone transfers aside),
 * a won deal, an accepted quote. Filed paperwork is any document on their record that isn't in the trash, anything sent
 * to them for signature, and any document generated for them.
 *
 * Read on basePrisma with the contact's workspace named in every query: the purge runs with no workspace, and the delete
 * action holds the contact row first — these counts read what is committed after that lock, so a transfer to the
 * contact either landed before (and is counted) or waits for the delete (and then finds them in the trash).
 */
export async function contactKeptBecause(tenantId: string | null, contactId: string): Promise<string | null> {
  const [vehicles, owned, won, accepted, filed, signed, generated] = await Promise.all([
    basePrisma.vehicle.count({ where: { tenantId, contactId, deletedAt: null } }),
    basePrisma.vehicleOwnership.count({ where: { tenantId, contactId, reversedAt: null } }),
    basePrisma.lead.count({ where: { tenantId, contactId, status: "won", deletedAt: null } }),
    basePrisma.quote.count({ where: { tenantId, contactId, status: "accepted", deletedAt: null } }),
    basePrisma.document.count({ where: { tenantId, contactId, deletedAt: null } }),
    // Paperwork sent for signature or generated for them counts too — the purge keeps those records (#1170).
    basePrisma.signatureRequest.count({ where: { tenantId, contactId } }),
    basePrisma.docInstance.count({ where: { tenantId, contactId } }),
  ]);
  return keptReason({ vehicles, owned, won, accepted, documents: filed + signed + generated });
}

/** Why a contact with these on record is kept, in words, or null when nothing keeps them. Pure. */
export function keptReason(n: { vehicles: number; owned: number; won: number; accepted: number; documents: number }): string | null {
  const plural = (count: number, one: string, many: string) => (count === 1 ? one : `${count} ${many}`);
  const reasons = [
    n.vehicles > 0 && `owns ${plural(n.vehicles, "a vehicle", "vehicles")}`,
    n.vehicles === 0 && n.owned > 0 && "owned a vehicle before",
    n.won > 0 && `has ${plural(n.won, "a won deal", "won deals")}`,
    n.accepted > 0 && `has ${plural(n.accepted, "an accepted quote", "accepted quotes")}`,
    n.documents > 0 && `has ${plural(n.documents, "a filed document", "filed documents")}`,
  ].filter(Boolean) as string[];
  if (reasons.length === 0) return null;
  const list = reasons.length === 1 ? reasons[0] : `${reasons.slice(0, -1).join(", ")} and ${reasons[reasons.length - 1]}`;
  return `This customer ${list}, so they're kept for good and can't be deleted.`;
}
