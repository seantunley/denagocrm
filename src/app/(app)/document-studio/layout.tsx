import { requirePermission } from "@/lib/permissions";

export default async function DocumentStudioLayout({ children }: { children: React.ReactNode }) {
  await requirePermission("document_templates.manage");
  return children;
}
