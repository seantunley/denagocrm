import { requireAnyPermission } from "@/lib/permissions";

export default async function WorkshopCalendarLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission("jobcards.view_all", "jobcards.view_owned", "activities.view");
  return children;
}
