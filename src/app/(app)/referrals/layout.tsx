import { requireAnyPermission } from "@/lib/permissions";

export default async function ReferralsLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission("referrals.view", "referrals.manage");
  return children;
}
