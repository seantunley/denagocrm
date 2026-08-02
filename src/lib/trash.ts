import { subDays } from "date-fns";
import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";
import { activeTenantPredicate } from "./tenantPredicate";
import { deleteFile } from "./storage";
import { type CustomEntity } from "./customFields";

export const TRASH_RETENTION_DAYS = 60;

export type TrashModel =
  | "contact"
  | "lead"
  | "vehicle"
  | "jobCard"
  | "document"
  | "product"
  | "libraryDocument"
  | "quote";

export const TRASH_MODELS: TrashModel[] = [
  "contact",
  "lead",
  "vehicle",
  "jobCard",
  "document",
  "product",
  "libraryDocument",
  "quote",
];

/* eslint-disable @typescript-eslint/no-explicit-any */
function delegate(model: TrashModel): any {
  return (basePrisma as any)[model];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * The active tenant. Every trash model carries `tenantId`, and delegate() runs
 * on basePrisma — which BYPASSES the RLS extension — so the predicate has to be
 * written by hand at each write.
 *
 * Resolved here rather than passed in, because a parameter is a thing a caller
 * can get wrong: six callers reached these helpers and only one thought about
 * tenancy. Taking the decision away from them is the fix.
 */
function activeTenantWhere(): { tenantId?: string | null } {
  return activeTenantPredicate("softDeleteRecord/restoreRecord");
}

/**
 * Soft-delete one record, within the active tenant.
 *
 * `where: { id }` alone is a cross-tenant write waiting for a caller whose
 * authorization check answers "yes" without looking at the tenant — and that is
 * the NORM here, not the exception: every canAccess*() helper in this app
 * returns true for any supplied id once the user holds the matching `view_all`,
 * because "all" was written to mean "all of mine". The deletion then ran
 * unrestricted. Documents were the reported case; contacts, leads, vehicles,
 * products and library documents had the identical shape.
 *
 * The predicate is applied unconditionally so no caller can omit it, and the
 * write is conditional (updateMany) so another tenant's id matches no rows
 * instead of deleting one.
 *
 * Returns null when nothing matched: a caller that assumed a row came back has
 * to handle the miss rather than logging a deletion that never happened.
 */
export async function softDeleteRecord(
  model: TrashModel,
  id: string,
  reason: string,
  userName: string
) {
  const rows = await delegate(model).updateMany({
    where: { id, ...activeTenantWhere() },
    data: { deletedAt: new Date(), deleteReason: reason, deletedByName: userName },
  });
  if (rows.count === 0) return null;
  return delegate(model).findFirst({ where: { id, ...activeTenantWhere() } });
}

/**
 * Restore one record, within the active tenant — same reasoning as the delete.
 * Restoring another tenant's row is the same cross-tenant write in reverse:
 * it resurrects data the other tenant deliberately deleted.
 *
 * Returns null when nothing matched, so a caller cannot announce a restore
 * that did not happen.
 */
export async function restoreRecord(model: TrashModel, id: string) {
  const rows = await delegate(model).updateMany({
    where: { id, ...activeTenantWhere() },
    data: { deletedAt: null, deleteReason: null, deletedByName: null },
  });
  if (rows.count === 0) return null;
  return delegate(model).findFirst({ where: { id, ...activeTenantWhere() } });
}

/** Permanently removes trash older than the retention window. Returns count purged. */
export async function purgeTrash(): Promise<number> {
  const cutoff = subDays(new Date(), TRASH_RETENTION_DAYS);
  let purged = 0;

  // documents first: their stored files must go too. Delete the ROW before the
  // file — if the row delete fails we keep the file, rather than leaving a live
  // row pointing at a now-missing blob and falsely counting it as purged.
  const staleDocs = await basePrisma.document.findMany({
    where: { deletedAt: { lt: cutoff } },
  });
  for (const doc of staleDocs) {
    // Guard on deletedAt: a document restored between the scan and now cleared
    // its deletedAt, so the guarded deleteMany matches 0 rows and we skip it —
    // never purging (or orphaning the file of) a record that left the trash.
    const { count } = await basePrisma.document
      .deleteMany({ where: { id: doc.id, deletedAt: { lt: cutoff } } })
      .catch(() => ({ count: 0 }));
    if (count === 0) continue; // restored or already gone — keep the file
    await deleteFile(doc.storedName).catch(() => {});
    purged++;
  }

  // library documents: same guarded delete (the row cascades its versions), then
  // remove the version files we captured up-front.
  const staleLibrary = await basePrisma.libraryDocument.findMany({
    where: { deletedAt: { lt: cutoff } },
    include: { versions: true },
  });
  for (const doc of staleLibrary) {
    const { count } = await basePrisma.libraryDocument
      .deleteMany({ where: { id: doc.id, deletedAt: { lt: cutoff } } })
      .catch(() => ({ count: 0 }));
    if (count === 0) continue; // restored or already gone — keep its files
    for (const v of doc.versions) await deleteFile(v.storedName).catch(() => {});
    purged++;
  }

  // Models whose rows own custom-field values (EAV, no FK → no cascade). When
  // such a row is permanently purged, its custom values must be deleted in the
  // same pass or they orphan (and can retain PII long past the retention window).
  const customEntityFor: Partial<Record<TrashModel, CustomEntity>> = {
    quote: "quote",
    lead: "lead",
    contact: "contact",
  };

  // Postgres table names for the FOR UPDATE lock below — a fixed whitelist,
  // because they interpolate as raw SQL identifiers and must never be user input.
  const tableName: Partial<Record<TrashModel, string>> = {
    quote: "Quote",
    lead: "Lead",
    contact: "Contact",
  };

  // children before parents so FK cascades behave predictably
  for (const model of ["quote", "jobCard", "vehicle", "lead", "contact", "product"] as TrashModel[]) {
    const entity = customEntityFor[model];
    if (!entity) {
      const res = await delegate(model)
        .deleteMany({ where: { deletedAt: { lt: cutoff } } })
        .catch(() => ({ count: 0 }));
      purged += res.count;
      continue;
    }

    const staleIds: string[] = (
      await delegate(model)
        .findMany({ where: { deletedAt: { lt: cutoff } }, select: { id: true } })
        .catch(() => [])
    ).map((r: { id: string }) => r.id);
    if (staleIds.length === 0) continue;

    const table = tableName[model]!;
    // Stored blobs to remove AFTER the row transaction commits. File deletion is
    // irreversible, so it must never happen inside the tx — a rolled-back purge
    // must not lose its files.
    let orphanFiles: string[] = [];

    try {
      const res = await basePrisma.$transaction(async (tx) => {
        // Lock the still-stale rows FOR UPDATE. A restore clears deletedAt via an
        // UPDATE on the same row, which now blocks until we commit — so we never
        // purge a record that left the trash mid-pass, and (for contacts) never
        // delete a restored contact's children. Records restored before we lock
        // fail the `deletedAt < cutoff` predicate and are excluded outright.
        const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT "id" FROM ${Prisma.raw(`"${table}"`)}
          WHERE "id" IN (${Prisma.join(staleIds)}) AND "deletedAt" < ${cutoff}
          FOR UPDATE`);
        const ids = locked.map((r) => r.id);
        if (ids.length === 0) return { count: 0 };

        // Contact has ON DELETE RESTRICT children (support cases + portal uploads)
        // that otherwise block the delete and silently defeat retention / POPIA
        // cleanup — the contact would linger forever. Purge them first (uploads
        // before cases: PortalUpload.caseId → CustomerCase is SET NULL, and the
        // upload is the customer's own data). Capture upload blobs for post-commit
        // removal. The other portal tables are ON DELETE CASCADE, so they go with
        // the contact automatically.
        if (model === "contact") {
          const [uploads, caseRows] = await Promise.all([
            tx.portalUpload.findMany({ where: { contactId: { in: ids } }, select: { storedName: true } }),
            tx.customerCase.findMany({ where: { contactId: { in: ids } }, select: { id: true } }),
          ]);
          orphanFiles = uploads.map((u) => u.storedName);
          await tx.portalUpload.deleteMany({ where: { contactId: { in: ids } } });
          // Case custom values key on the CASE id (def.entity = "case"), not the
          // contact, so deleting the cases below would orphan any PII held in a
          // case custom field. Clear them first. (Leads/quotes are SET NULL on
          // contact delete — they survive, so their custom values are untouched.)
          const caseIds = caseRows.map((c) => c.id);
          if (caseIds.length > 0) {
            await tx.customFieldValue.deleteMany({
              where: { recordId: { in: caseIds }, def: { entity: "case" } },
            });
          }
          await tx.customerCase.deleteMany({ where: { contactId: { in: ids } } });
        }

        // Custom values (EAV, no FK → no cascade) for exactly the rows removed.
        await tx.customFieldValue.deleteMany({
          where: { recordId: { in: ids }, def: { entity } },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (tx as any)[model].deleteMany({ where: { id: { in: ids } } });
      });
      purged += res.count;
    } catch {
      // parent + children + custom values roll back together; nothing purged
      continue;
    }

    for (const stored of orphanFiles) await deleteFile(stored).catch(() => {});
  }
  return purged;
}
