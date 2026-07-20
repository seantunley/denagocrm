import { subDays } from "date-fns";
import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";
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

export async function softDeleteRecord(
  model: TrashModel,
  id: string,
  reason: string,
  userName: string
) {
  return delegate(model).update({
    where: { id },
    data: { deletedAt: new Date(), deleteReason: reason, deletedByName: userName },
  });
}

export async function restoreRecord(model: TrashModel, id: string) {
  return delegate(model).update({
    where: { id },
    data: { deletedAt: null, deleteReason: null, deletedByName: null },
  });
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
    try {
      await basePrisma.document.delete({ where: { id: doc.id } });
    } catch {
      continue; // row survived — leave its file intact, don't count it
    }
    await deleteFile(doc.storedName).catch(() => {});
    purged++;
  }

  // library documents: same ordering — the row (which cascades its versions)
  // goes first; only then do we remove the version files we captured up-front.
  const staleLibrary = await basePrisma.libraryDocument.findMany({
    where: { deletedAt: { lt: cutoff } },
    include: { versions: true },
  });
  for (const doc of staleLibrary) {
    try {
      await basePrisma.libraryDocument.delete({ where: { id: doc.id } });
    } catch {
      continue; // row survived — keep its files
    }
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
          const uploads = await tx.portalUpload.findMany({
            where: { contactId: { in: ids } },
            select: { storedName: true },
          });
          orphanFiles = uploads.map((u) => u.storedName);
          await tx.portalUpload.deleteMany({ where: { contactId: { in: ids } } });
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
