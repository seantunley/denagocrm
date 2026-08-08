import { buildNav } from "@/components/nav-config";

export type MarketingWorkspaceSection = {
  href: string;
  label: string;
};

/**
 * Keep the workspace navigation on the same RBAC decision as the application
 * navigation. The full Marketing group is returned so this shell does not
 * maintain a narrower, independently curated answer.
 */
export function buildMarketingWorkspaceSections(
  isAdmin: boolean,
  permissions: string[] = [],
): MarketingWorkspaceSection[] {
  const marketing = buildNav(isAdmin, permissions).groups.find(
    (group) => group.key === "marketing",
  );

  return (marketing?.links ?? []).map(({ href, label }) => ({ href, label }));
}
