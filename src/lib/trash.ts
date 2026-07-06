import { subDays } from "date-fns";
import { basePrisma } from "./db";
import { deleteFile } from "./storage";

export const TRASH_RETENTION_DAYS = 60;

export type TrashModel = "contact" | "lead" | "vehicle" | "jobCard" | "document" | "product";

export const TRASH_MODELS: TrashModel[] = [
  "contact",
  "lead",
  "vehicle",
  "jobCard",
  "document",
  "product",
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

  // children before parents so FK cascades behave predictably
  for (const model of ["jobCard", "vehicle", "lead", "contact", "product"] as TrashModel[]) {
    const res = await delegate(model)
      .deleteMany({ where: { deletedAt: { lt: cutoff } } })
      .catch(() => ({ count: 0 }));
    purged += res.count;
  }
  return purged;
}
