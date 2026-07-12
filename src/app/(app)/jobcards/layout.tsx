import { requireAnyPermission } from "@/lib/permissions";

export default async function JobCardsLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission("jobcards.view_all", "jobcards.view_owned");
  return children;
}
