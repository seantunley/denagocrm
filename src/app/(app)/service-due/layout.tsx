import { requireAnyPermission } from "@/lib/permissions";

export default async function ServiceDueLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission("vehicles.view_all", "vehicles.view_owned");
  return children;
}
