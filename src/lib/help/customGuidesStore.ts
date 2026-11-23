import "server-only";
import { getWorkspaceSetting, putWorkspaceSetting, settingsTenantId } from "@/lib/settings";
import { CUSTOM_GUIDES_KEY, parseGuides, type CustomGuide } from "./customGuides";

/**
 * A workspace's own help guides, read and written (rules: ./customGuides.ts).
 * Always the ACTING workspace's setting, named by its tenant — one workspace's
 * guides must never be another's.
 */
export async function loadCustomGuides(): Promise<CustomGuide[]> {
  return parseGuides(await getWorkspaceSetting(await settingsTenantId(), CUSTOM_GUIDES_KEY));
}

export async function storeCustomGuides(guides: readonly CustomGuide[]): Promise<void> {
  await putWorkspaceSetting(await settingsTenantId(), CUSTOM_GUIDES_KEY, JSON.stringify(guides));
}
