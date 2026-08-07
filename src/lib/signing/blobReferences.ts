import "server-only";
import { basePrisma } from "@/lib/db";
import { signedPdfIsUnreferenced, type BlobReferenceProbes } from "./compensate";

/**
 * The database side of the compensating-delete decision: ask every durable
 * reference whether it still names this blob.
 *
 * Separated from the pure rule in compensate.ts, and from the 200-line
 * completion function that calls it, so the QUERIES can be tested. The rule was
 * only half the bug — the other half was asking the wrong thing, and no test of
 * a pure predicate can catch that.
 *
 * ── WHY basePrisma ─────────────────────────────────────────────────────────
 *
 * `prisma` HIDES soft-deleted rows. `findUnique` on the filtered client returns
 * null for a trashed request (db.ts injects `deletedAt` into the select and
 * treats a set value as absence), and that null reads as "nothing references the
 * blob". So: complete, trash the request, and the next failed completion — or a
 * retry of this one — deletes the signed PDF while the `Document` it is filed as
 * still points at it. Trash is also restorable, so a trashed row is not even a
 * dead reference. `basePrisma` applies no such filter and no RLS, which is what
 * makes the answer trustworthy.
 *
 * ── WHY BOTH TABLES ────────────────────────────────────────────────────────
 *
 * The completion transaction writes the blob's name in two places —
 * `SignatureRequest.signedPdfRef` and `Document.storedName` — and after a lost
 * commit acknowledgement either may exist. `Document` is the one a person
 * actually opens: it is what the Documents tab and the deliveries board link to.
 * Asking only about the request is how the same contract gets deleted twice.
 *
 * ── WHY THE TENANT IS PASSED IN ────────────────────────────────────────────
 *
 * `basePrisma` bypasses both the tenant guard and RLS, so nothing scopes these
 * counts unless we do. The owning tenant comes from the request row itself.
 *
 * A request with NO tenant recorded (the normal shape today — `stampCreate` runs
 * only under enforcement) is searched UNSCOPED, deliberately. The asymmetry is
 * the whole design: widening a reference search can only ever keep a file that
 * did not need keeping, while narrowing one deletes a contract. So the search
 * may be widened freely and must never be narrowed on a guess.
 */
export function durableBlobReferenceProbes(
  storedName: string,
  tenantId: string | null,
): BlobReferenceProbes {
  const tenantWhere = tenantId ? { tenantId } : {};
  return {
    "SignatureRequest.signedPdfRef": () =>
      basePrisma.signatureRequest.count({ where: { ...tenantWhere, signedPdfRef: storedName } }),
    "Document.storedName": () =>
      basePrisma.document.count({ where: { ...tenantWhere, storedName } }),
  };
}

/**
 * True only when NOTHING durable names this blob, so the compensating delete may
 * run. False — keep the file — on every reference found, every failed probe and
 * every unreadable answer.
 */
export async function signedPdfIsSafeToDelete(
  storedName: string,
  tenantId: string | null,
): Promise<boolean> {
  return signedPdfIsUnreferenced(storedName, durableBlobReferenceProbes(storedName, tenantId));
}
