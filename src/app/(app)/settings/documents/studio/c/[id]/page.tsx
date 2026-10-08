import { redirect } from "next/navigation";
import { requireAnyPermission } from "@/lib/permissions";

/**
 * The old Studio clause editor is gone — there is ONE document editor
 * (2026-10-07). Reusable clauses are saved and inserted from its Library tab.
 */
export default async function OldStudioClausePage() {
  await requireAnyPermission("document_templates.manage", "docbuilder.manage");
  redirect("/document-studio");
}
