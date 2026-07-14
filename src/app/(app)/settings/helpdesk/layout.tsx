import { requirePermission } from "@/lib/permissions";

export default async function Layout({ children }: { children: React.ReactNode }) {
  await requirePermission("cases.manage");
  return <>{children}</>;
}
