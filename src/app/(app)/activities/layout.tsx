import { requireAnyPermission } from "@/lib/permissions";

export default async function ActivitiesLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission("activities.view", "activities.manage");
  return children;
}
