import { requireAnyPermission } from "@/lib/permissions";

export default async function CalendarLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission("activities.view", "activities.manage");
  return children;
}
