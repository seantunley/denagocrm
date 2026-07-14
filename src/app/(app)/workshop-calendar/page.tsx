import CalendarView from "@/components/CalendarView";
import { getAccessibleActivityIds } from "@/lib/activityAccess";
import { requireAnyPermission } from "@/lib/permissions";

export default async function WorkshopCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  const user = await requireAnyPermission(
    "jobcards.view_all",
    "jobcards.view_owned",
    "activities.view",
    "activities.manage"
  );
  const [{ m }, activityIds] = await Promise.all([
    searchParams,
    getAccessibleActivityIds(user),
  ]);
  return <CalendarView mode="workshop" m={m} activityIds={activityIds} />;
}
