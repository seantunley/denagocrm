import { requireAnyPermission, getUserPermissionList } from "@/lib/permissions";
import { isTenantOwner } from "@/lib/auth";
import MarketingWorkspaceShell from "@/components/marketing/MarketingWorkspaceShell";
import { buildMarketingWorkspaceSections } from "@/components/marketing/marketing-workspace-nav";

export default async function ReferralsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireAnyPermission("referrals.view", "referrals.manage");
  const permissions = await getUserPermissionList(user);
  // The workspace's owner, not only the platform owner.
  const sections = buildMarketingWorkspaceSections(await isTenantOwner(), permissions);

  return <MarketingWorkspaceShell sections={sections}>{children}</MarketingWorkspaceShell>;
}
