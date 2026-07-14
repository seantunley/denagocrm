import { requireAnyPermission } from "@/lib/permissions";

export default async function LibraryLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission("library.view", "library.manage");
  return children;
}
