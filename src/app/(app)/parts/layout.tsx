import { requireAnyPermission } from "@/lib/permissions";

export default async function PartsLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission("parts.view", "parts.manage");
  return children;
}
