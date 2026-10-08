import { notFound, redirect } from "next/navigation";
import { requireAnyPermission } from "@/lib/permissions";
import { getTemplateRecord } from "@/lib/docTemplateStore";
import { isDocKey } from "@/lib/docTemplates";
import { defaultBuilderTemplateId } from "@/lib/docbuilder/store";

export const dynamic = "force-dynamic";

/**
 * The old form editor (logo, text boxes, section switches) is gone: every
 * document's design AND wording — bank details, payment terms, clauses — is
 * edited in the one document editor (2026-10-07; asked for repeatedly). An old
 * link lands on that document's layout there, or on Document Studio.
 */
export default async function OldTemplateEditorPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAnyPermission("document_templates.manage", "docbuilder.manage");
  const { id } = await params;
  const record = await getTemplateRecord(id);
  if (!record || record.deletedAt || !isDocKey(record.docType)) notFound();
  const layoutId = await defaultBuilderTemplateId(record.docType);
  redirect(layoutId ? `/doc-editor/${layoutId}` : "/document-studio");
}
