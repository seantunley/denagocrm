import { requireAnyPermission, getUserPermissionList } from "@/lib/permissions";
import MarketingWorkspaceShell from "@/components/marketing/MarketingWorkspaceShell";
import { buildMarketingWorkspaceSections } from "@/components/marketing/marketing-workspace-nav";

export default async function ReferralsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireAnyPermission("referrals.view", "referrals.manage");
  const permissions = await getUserPermissionList(user);
  const sections = buildMarketingWorkspaceSections(user.role === "owner", permissions);

  return <MarketingWorkspaceShell sections={sections}>{children}</MarketingWorkspaceShell>;
}
