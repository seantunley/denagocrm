import { requireAnyPermission } from "@/lib/permissions";

export default async function ContactsLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission("contacts.view_all", "contacts.view_owned");
  return children;
}
