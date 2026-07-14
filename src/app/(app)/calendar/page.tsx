import CalendarView from "@/components/CalendarView";
import { getAccessibleActivityIds } from "@/lib/activityAccess";
import { requireAnyPermission } from "@/lib/permissions";

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  const user = await requireAnyPermission("activities.view", "activities.manage");
  const [{ m }, activityIds] = await Promise.all([
    searchParams,
    getAccessibleActivityIds(user),
  ]);
  return <CalendarView mode="sales" m={m} activityIds={activityIds} />;
}
