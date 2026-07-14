import { requirePermission } from "@/lib/permissions";

export default async function DuplicatesLayout({ children }: { children: React.ReactNode }) {
  await requirePermission("contacts.merge");
  return children;
}
