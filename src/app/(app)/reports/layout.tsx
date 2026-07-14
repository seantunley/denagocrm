import { requireAnyPermission } from "@/lib/permissions";

export default async function ReportsLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission("reports.view_all", "reports.view_team", "reports.view");
  return children;
}
