import { requireAnyPermission } from "@/lib/permissions";

export default async function DocumentsLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission(
    "documents.view_all",
    "documents.view_owned",
    "documents.upload",
    "documents.manage",
    "document_templates.manage"
  );
  return children;
}
