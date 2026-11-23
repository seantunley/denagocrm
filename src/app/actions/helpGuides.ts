"use server";

import { randomBytes } from "crypto";
import { revalidatePath } from "next/cache";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { requireTenantOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { isGuideId, readGuideInput, removeGuide, saveGuide } from "@/lib/help/customGuides";
import { loadCustomGuides, storeCustomGuides } from "@/lib/help/customGuidesStore";

/** The workspace's own help guides (lib/help/customGuides.ts). Owner only; every change audited. */

function refresh() {
  revalidatePath("/help", "layout");
}

/** Create a guide, or save changes to one (a hidden `id`). */
export async function saveHelpGuide(formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const read = readGuideInput({ title: formData.get("title"), summary: formData.get("summary"), area: formData.get("area"), body: formData.get("body") });
    if (!read.ok) refuse(read.error);
    const given = String(formData.get("id") ?? "");
    const existing = given !== "";
    if (existing && !isGuideId(given)) refuse("That guide can't be saved — reload the page and try again.");
    const id = existing ? given : randomBytes(8).toString("hex");
    const changed = saveGuide(await loadCustomGuides(), read.input, { id, existing, at: new Date().toISOString(), by: user.name });
    if (!changed.ok) refuse(changed.error);
    await storeCustomGuides(changed.guides);
    await logAudit({ action: "help.guide_saved", summary: `Help guide ${existing ? "updated" : "added"}: ${read.input.title}`, user });
    refresh();
  });
}

/** Deleting asks why (the shared confirmation does); the reason goes on the audit trail. */
export async function deleteHelpGuide(id: string, formData?: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    if (!isGuideId(id)) refuse("That guide is already gone — refresh the page.");
    const guides = await loadCustomGuides();
    const guide = guides.find((item) => item.id === id);
    if (!guide) refuse("That guide is already gone — refresh the page.");
    const reason = String(formData?.get("reason") ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    await storeCustomGuides(removeGuide(guides, id));
    await logAudit({ action: "help.guide_deleted", summary: `Help guide deleted: ${guide.title}${reason ? ` — ${reason}` : ""}`, user });
    refresh();
  });
}
