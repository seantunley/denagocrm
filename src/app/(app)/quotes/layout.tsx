import { requireAnyPermission } from "@/lib/permissions";

export default async function QuotesLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission("quotes.view_all", "quotes.view_owned");
  return children;
}
