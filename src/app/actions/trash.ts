"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { restoreRecord, TRASH_MODELS, type TrashModel } from "@/lib/trash";

export async function restoreFromTrash(model: TrashModel, id: string) {
  const user = await requireUser();
  if (!TRASH_MODELS.includes(model)) return;
  const record = await restoreRecord(model, id);
  await logAudit({
    action: "trash.restored",
    summary: `Restored ${model} “${record.title ?? record.model ?? record.fileName ?? record.firstName ?? record.name ?? id}” from trash`,
    contactId: model === "contact" ? id : record.contactId ?? null,
    leadId: model === "lead" ? id : null,
    user,
  });
  revalidatePath("/trash");
  revalidatePath("/contacts");
  revalidatePath("/leads");
  revalidatePath("/vehicles");
  revalidatePath("/jobcards");
  revalidatePath("/products");
}
