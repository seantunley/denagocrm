import { subDays } from "date-fns";
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

    // Delete the parent rows AND their custom values in one transaction so a
    // failed parent delete can't leave a recoverable record stripped of its
    // custom data. Two subtleties matter:
    //   1. The parent delete is guarded by `deletedAt < cutoff` (NOT a raw id
    //      list), so a record RESTORED between the candidate scan and this
    //      transaction is no longer stale and is left untouched — no purge of a
    //      record that is no longer in the trash.
    //   2. Custom values are deleted only for rows we ACTUALLY removed. deleteMany
    //      can't return ids, so after the delete we re-read which candidates
    //      survived (were restored) and subtract them; the remainder are the
    //      truly-deleted ids. This keeps custom-value deletion in lockstep with
    //      the parent rows even under a concurrent restore.
    const staleIds: string[] = (
      await delegate(model)
        .findMany({ where: { deletedAt: { lt: cutoff } }, select: { id: true } })
        .catch(() => [])
    ).map((r: { id: string }) => r.id);
    if (staleIds.length === 0) continue;

    try {
      const res = await basePrisma.$transaction(async (tx) => {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const del = await (tx as any)[model].deleteMany({
          where: { id: { in: staleIds }, deletedAt: { lt: cutoff } },
        });
        const survivors: { id: string }[] = await (tx as any)[model].findMany({
          where: { id: { in: staleIds } },
          select: { id: true },
        });
        /* eslint-enable @typescript-eslint/no-explicit-any */
        const survivorIds = new Set(survivors.map((r) => r.id));
        const deletedIds = staleIds.filter((id) => !survivorIds.has(id));
        if (deletedIds.length > 0) {
          await tx.customFieldValue.deleteMany({
            where: { recordId: { in: deletedIds }, def: { entity } },
          });
        }
        return del;
      });
      purged += res.count;
    } catch {
      // parent + custom values rolled back together; nothing purged this pass
    }
  }
  return purged;
}
