import { requireAnyPermission } from "@/lib/permissions";

export default async function WarrantyLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission("warranty.view", "warranty.manage");
  return children;
}
