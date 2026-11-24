import { getWorkspaceSetting } from "./settings";
import { ASSISTANT_PROFILE_KEY, DEFAULT_PROFILE, parseProfile } from "./assistantSoul";

/**
 * What the named workspace calls its assistant (Settings → Assistant; "Assistant" until it is named). Every label a
 * person sees uses this, never a fixed name: the name is the workspace's choice and can change (Sean, 2026-11-24).
 */
export async function assistantNameFor(tenantId: string | null): Promise<string> {
  if (!tenantId) return DEFAULT_PROFILE.name;
  return parseProfile(await getWorkspaceSetting(tenantId, ASSISTANT_PROFILE_KEY).catch(() => null)).name;
}
