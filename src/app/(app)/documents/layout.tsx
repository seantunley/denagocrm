import { requireAnyPermission } from "@/lib/permissions";

export default async function DocumentsLayout({ children }: { children: React.ReactNode }) {
  // Library permissions open the page too: the Document Library is merged into
  // it, and the page shows each half only to someone allowed it.
  await requireAnyPermission(
    "documents.view_all",
    "documents.view_owned",
    "documents.upload",
    "documents.manage",
    "document_templates.manage",
    "library.view",
    "library.manage"
  );
  return children;
}
