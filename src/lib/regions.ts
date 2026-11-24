import { REGIONAL_KEYS, getWorkspaceSetting } from "./settings";
import { REGIONS_KEY, REGION_LABEL_KEY, regionLabel, regionsOrDefault } from "./regionRules";

export type WorkspaceRegions = { label: string; options: string[] };

/** For a payload that offers no contact form. */
export const NO_REGIONS: WorkspaceRegions = { label: "Region", options: [] };

/** The named workspace's regions and what it calls them (lib/regionRules.ts). */
export async function workspaceRegions(tenantId: string | null): Promise<WorkspaceRegions> {
  const [list, label, currency] = tenantId
    ? await Promise.all([
        getWorkspaceSetting(tenantId, REGIONS_KEY),
        getWorkspaceSetting(tenantId, REGION_LABEL_KEY),
        getWorkspaceSetting(tenantId, REGIONAL_KEYS.currency),
      ])
    : [null, null, null];
  return { label: regionLabel(label, currency), options: regionsOrDefault(list, currency) };
}
