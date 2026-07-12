import { requireAnyPermission } from "@/lib/permissions";

export default async function DeliveriesLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission("deliveries.view", "deliveries.manage");
  return children;
}
