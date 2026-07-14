import { requireAnyPermission } from "@/lib/permissions";

export default async function InboxLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission("inbox.view", "inbox.reply");
  return children;
}
