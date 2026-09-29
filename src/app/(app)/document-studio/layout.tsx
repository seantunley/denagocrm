import { requireAnyPermission } from "@/lib/permissions";

/**
 * Document Studio replaced BOTH the template list (document_templates.manage)
 * and the Document Builder list (docbuilder.view / docbuilder.manage). Either
 * grant opens it; the page shows each section only to those allowed it.
 */
export default async function DocumentStudioLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission("document_templates.manage", "docbuilder.view", "docbuilder.manage");
  return children;
}
