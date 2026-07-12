import { requireAnyPermission } from "@/lib/permissions";

export default async function FleetsLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission("fleets.view", "fleets.manage");
  return children;
}
