import { redirect } from "next/navigation";

/**
 * The old Studio free-form editor is gone — there is ONE document editor
 * (2026-10-07). An old link to a document opens it there; that page does its
 * own access checks.
 */
export default async function OldStudioDocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/doc-editor/document/${encodeURIComponent(id)}`);
}
