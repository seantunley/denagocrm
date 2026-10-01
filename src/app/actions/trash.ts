"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { asActionResult, refuse } from "@/lib/actionResult";
import { restoreRecord, RESTORABLE_MODELS, type RestorableModel } from "@/lib/trash";

/** Where each kind of record is listed, so the restored row shows up there straight away. */
const LIST_PATH: Record<RestorableModel, string> = {
  contact: "/contacts",
  lead: "/leads",
  vehicle: "/vehicles",
  jobCard: "/jobcards",
  document: "/contacts",
  product: "/products",
  libraryDocument: "/documents",
  quote: "/quotes",
  fleet: "/fleets",
  part: "/parts",
  stockUnit: "/stock",
  survey: "/surveys",
  competitor: "/competitors",
  signWorkflow: "/settings/signing-workflows",
  docTemplateRecord: "/document-studio",
  docBuilderTemplate: "/document-studio",
  customDocTemplate: "/document-studio",
  docInstance: "/document-studio",
  reusableBlock: "/document-studio",
};

export async function restoreFromTrash(model: RestorableModel, id: string) {
  return asActionResult(async () => {
    const user = await requireOwner();
    if (!RESTORABLE_MODELS.includes(model)) refuse("That kind of record can't be restored.");
    const record = await restoreRecord(model, id).catch((error) => {
      // A live record took its unique number / serial / name while it was deleted.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        refuse("A live record already uses this one's number or name — change that one first, then restore.");
      }
      throw error;
    });
    // Nothing matched: the id belongs to another tenant, was purged, or was
    // already restored. Restoring another tenant's row resurrects data they
    // deliberately deleted, so this is a refusal — never an audited restore
    // that didn't happen.
    if (!record) refuse("That item is no longer in the trash — refresh the page.");
    await logAudit({
      action: "trash.restored",
      summary: `Restored ${model} “${record.title ?? record.model ?? record.fileName ?? record.firstName ?? record.name ?? record.stockNumber ?? id}” from trash`,
      contactId: model === "contact" ? id : record.contactId ?? null,
      leadId: model === "lead" ? id : null,
      user,
    });
    revalidatePath("/trash");
    revalidatePath(LIST_PATH[model]);
    return { success: "Restored." };
  });
}
