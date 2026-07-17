import CalendarView from "@/components/CalendarView";
import { getAccessibleActivityIds } from "@/lib/activityAccess";
import { hasPermission, requireAnyPermission } from "@/lib/permissions";

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string; d?: string }>;
}) {
  const user = await requireAnyPermission("activities.view", "activities.manage");
  const [{ m, d }, activityIds, canManage] = await Promise.all([
    searchParams,
    getAccessibleActivityIds(user),
    hasPermission(user, "activities.manage"),
  ]);
  return (
    <CalendarView
      mode="sales"
      m={m}
      initialDate={d}
      activityIds={activityIds}
      canManage={canManage}
    />
  );
}
