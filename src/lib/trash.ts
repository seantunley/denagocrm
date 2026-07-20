import { subDays } from "date-fns";
import { basePrisma } from "./db";
import { deleteFile } from "./storage";
import { deleteCustomValuesFor, type CustomEntity } from "./customFields";

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

  // documents first: their stored files must go too
  const staleDocs = await basePrisma.document.findMany({
    where: { deletedAt: { lt: cutoff } },
  });
  for (const doc of staleDocs) {
    await deleteFile(doc.storedName);
    await basePrisma.document.delete({ where: { id: doc.id } }).catch(() => {});
    purged++;
  }

  // library documents: remove all version files before the rows cascade away
  const staleLibrary = await basePrisma.libraryDocument.findMany({
    where: { deletedAt: { lt: cutoff } },
    include: { versions: true },
  });
  for (const doc of staleLibrary) {
    for (const v of doc.versions) await deleteFile(v.storedName);
    await basePrisma.libraryDocument.delete({ where: { id: doc.id } }).catch(() => {});
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
    const staleIds: string[] = entity
      ? (
          await delegate(model)
            .findMany({ where: { deletedAt: { lt: cutoff } }, select: { id: true } })
            .catch(() => [])
        ).map((r: { id: string }) => r.id)
      : [];
    const res = await delegate(model)
      .deleteMany({ where: { deletedAt: { lt: cutoff } } })
      .catch(() => ({ count: 0 }));
    purged += res.count;
    if (entity && staleIds.length > 0) {
      await deleteCustomValuesFor(entity, staleIds).catch(() => {});
    }
  }
  return purged;
}
