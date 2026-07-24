import { requireModuleEnabled } from "@/lib/modules/enabled";
import { requireAnyPermission } from "@/lib/permissions";

export default async function TestDrivesLayout({ children }: { children: React.ReactNode }) {
  await requireModuleEnabled("automotive");
  await requireAnyPermission("activities.view", "activities.manage");
  return children;
}
