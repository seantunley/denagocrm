import { requireAnyPermission } from "@/lib/permissions";

export default async function StockLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission("stock.view", "stock.manage");
  return children;
}
