"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { restoreRecord, TRASH_MODELS, type TrashModel } from "@/lib/trash";
import { withActingStaffScope } from "@/lib/actingScope";

export async function restoreFromTrash(model: TrashModel, id: string) {
  return withActingStaffScope(async () => {
    const user = await requireOwner();
    if (!TRASH_MODELS.includes(model)) return;
    const record = await restoreRecord(model, id);
    // Nothing matched: the id belongs to another tenant, or was purged. Restoring
    // another tenant's row resurrects data they deliberately deleted, so this is
    // a refusal — and without the check we would audit a restore that never
    // happened, then crash reading a title off null.
    if (!record) return;
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
  });
}
