import { redirect } from "next/navigation";
import { requireAnyPermission } from "@/lib/permissions";

/**
 * The old Studio free-form editor is gone — there is ONE document editor
 * (2026-10-07). Custom templates are made and edited there, from Document Studio.
 */
export default async function OldStudioTemplatePage() {
  await requireAnyPermission("document_templates.manage", "docbuilder.manage");
  redirect("/document-studio");
}
