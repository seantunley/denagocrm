import type { ReactNode } from "react";
import { isTenantOwner, requireUser } from "@/lib/auth";
import { requireModuleEnabled } from "@/lib/modules/enabled";
import { getUserPermissionList } from "@/lib/permissions";
import MarketingWorkspaceShell from "@/components/marketing/MarketingWorkspaceShell";
import { buildMarketingWorkspaceSections } from "@/components/marketing/marketing-workspace-nav";

export default async function MarketingLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const [, permissions] = await Promise.all([
    requireModuleEnabled("marketing"),
    getUserPermissionList(user),
  ]);
  // The workspace's owner, not only the platform owner.
  const sections = buildMarketingWorkspaceSections(await isTenantOwner(), permissions);

  return <MarketingWorkspaceShell sections={sections}>{children}</MarketingWorkspaceShell>;
}
