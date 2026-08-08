import { buildNav } from "@/components/nav-config";

export type MarketingWorkspaceSection = {
  href: string;
  label: string;
};

/**
 * Keep the workspace navigation on the same RBAC decision as the application
 * navigation. Only direct /marketing children are top-level workspace tabs;
 * deeper pages (such as survey insights) remain active beneath their parent.
 */
export function buildMarketingWorkspaceSections(
  isAdmin: boolean,
  permissions: string[] = [],
): MarketingWorkspaceSection[] {
  const marketing = buildNav(isAdmin, permissions).groups.find(
    (group) => group.key === "marketing",
  );

  return (marketing?.links ?? [])
    .filter((link) => /^\/marketing\/[^/]+$/.test(link.href))
    .map(({ href, label }) => ({ href, label }));
}
