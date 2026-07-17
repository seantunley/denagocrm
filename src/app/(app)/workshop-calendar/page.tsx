import CalendarView from "@/components/CalendarView";
import { getAccessibleActivityIds } from "@/lib/activityAccess";
import { hasPermission, requireAnyPermission } from "@/lib/permissions";

export default async function WorkshopCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string; d?: string }>;
}) {
  const user = await requireAnyPermission(
    "jobcards.view_all",
    "jobcards.view_owned",
    "activities.view",
    "activities.manage",
  );
  const [{ m, d }, activityIds, canManage] = await Promise.all([
    searchParams,
    getAccessibleActivityIds(user),
    hasPermission(user, "activities.manage"),
  ]);
  return (
    <CalendarView
      mode="workshop"
      m={m}
      initialDate={d}
      activityIds={activityIds}
      canManage={canManage}
    />
  );
}
