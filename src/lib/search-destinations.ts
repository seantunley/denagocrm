import { buildNav } from "@/components/nav-config";
import { settingsDestination, visibleSettingsGroups } from "@/lib/settings-navigation";

export type SearchDestination = {
  href: string;
  label: string;
  group: string;
  keywords: string[];
};

export function getSearchDestinations({
  isAdmin,
  isPlatformOwner = false,
  permissions = [],
}: {
  /** Owner of the workspace being viewed. */
  isAdmin: boolean;
  /** The platform-wide owner role — the only viewer of platform settings. */
  isPlatformOwner?: boolean;
  permissions?: string[];
}): SearchDestination[] {
  const { topLinks, groups } = buildNav(isAdmin, permissions);
  const destinations: SearchDestination[] = [
    ...topLinks.map((item) => ({ ...item, group: "Workspace", keywords: item.keywords ?? [] })),
    ...groups.flatMap((group) =>
      group.links.map((item) => ({
        ...item,
        group: group.label,
        keywords: item.keywords ?? [],
      })),
    ),
    {
      href: "/settings",
      label: "Settings",
      group: "Account",
      keywords: ["preferences", "configuration"],
    },
    ...visibleSettingsGroups({ isOwner: isAdmin, isPlatformOwner, permissions }).flatMap((group) =>
      group.items.map((item) => ({
        href: settingsDestination(item),
        label: item.label,
        group: `Settings · ${group.label}`,
        keywords: item.keywords ?? [],
      })),
    ),
  ];

  return [...new Map(destinations.map((item) => [item.href, item])).values()];
}

export function matchSearchDestinations(term: string, destinations: SearchDestination[]) {
  const query = term.trim().toLocaleLowerCase();
  if (!query) return [];

  return destinations
    .filter((item) =>
      [item.label, item.group, item.href, ...item.keywords]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query),
    )
    .sort((a, b) => {
      const aLabel = a.label.toLocaleLowerCase();
      const bLabel = b.label.toLocaleLowerCase();
      const aRank = aLabel === query ? 0 : aLabel.startsWith(query) ? 1 : 2;
      const bRank = bLabel === query ? 0 : bLabel.startsWith(query) ? 1 : 2;
      return aRank - bRank || a.label.localeCompare(b.label);
    })
    .slice(0, 20);
}
