import { requireUser } from "@/lib/auth";
import CalendarView from "@/components/CalendarView";

export default async function WorkshopCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  await requireUser();
  const { m } = await searchParams;
  return <CalendarView mode="workshop" m={m} />;
}
