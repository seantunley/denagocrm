import "server-only";
import { basePrisma } from "./db";

/**
 * A claim shows its CLAIMANT — WarrantyClaim.contactId, the owner when it was logged — never the vehicle's current
 * owner (warranty-transfer-brief.md). Every claim reader loads `claim.vehicle.contact` and shows it, so this swaps that
 * contact for the claimant wherever they differ: one call per reader, the rest of each screen unchanged.
 *
 * Read with the workspace named and trashed contacts included (a claimant in the trash is still who claimed). A
 * claimant since purged shows as "Previous owner (deleted)" with no details — never the current owner's.
 */
type HasContact = { id: string; firstName: string } & Record<string, unknown>;
type ClaimLike<C extends HasContact> = { contactId: string | null; vehicle: { tenantId: string | null; contactId: string; contact: C } };

export async function withClaimants<C extends HasContact, T extends ClaimLike<C>>(claims: T[]): Promise<T[]> {
  const wanted = claims.filter((c) => c.contactId && c.contactId !== c.vehicle.contactId);
  if (wanted.length === 0) return claims;
  const tenantIds = [...new Set(wanted.map((c) => c.vehicle.tenantId).filter((t): t is string => Boolean(t)))];
  const rows = tenantIds.length
    ? await basePrisma.contact.findMany({ where: { id: { in: wanted.map((c) => c.contactId!) }, tenantId: { in: tenantIds } } })
    : [];
  const byId = new Map(rows.map((row) => [row.id, row as unknown as C]));
  return claims.map((claim) => {
    if (!claim.contactId || claim.contactId === claim.vehicle.contactId) return claim;
    const found = byId.get(claim.contactId);
    // Gone for good: every detail blank, so nothing of the current owner's is shown in its place.
    const claimant = found ?? ({ ...Object.fromEntries(Object.keys(claim.vehicle.contact).map((k) => [k, null])), id: claim.contactId, firstName: "Previous owner (deleted)", isCompany: false } as unknown as C);
    return { ...claim, vehicle: { ...claim.vehicle, contact: claimant } };
  });
}

export async function withClaimant<C extends HasContact, T extends ClaimLike<C>>(claim: T): Promise<T> {
  return (await withClaimants([claim]))[0];
}
