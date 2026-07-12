import { requireAnyPermission } from "@/lib/permissions";

export default async function CasesLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission("cases.view_all", "cases.view_owned");
  return children;
}
