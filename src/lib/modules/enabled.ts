import "server-only";
import { cache } from "react";
import { getSetting, putSetting } from "@/lib/settings";
import {
  ALL_MODULE_IDS,
  OPTIONAL_MODULE_IDS,
  type ModuleId,
} from "./registry";

// We persist the DISABLED optional packs, not the enabled ones. Storing the
// disabled set means a newly-added module defaults ON for every existing
// install (it simply isn't in anyone's disabled list yet) — so shipping a new
// pack never silently removes it from tenants who saved module settings before
// it existed. Unset = nothing disabled = every module on.
const SETTING_KEY = "DISABLED_MODULES";

/** Enabled module ids for this install. Core is always included; new modules default on. */
export const getEnabledModuleIds = cache(async (): Promise<Set<ModuleId>> => {
  const value = await getSetting(SETTING_KEY).catch(() => null);
  const set = new Set<ModuleId>(ALL_MODULE_IDS);
  if (!value) return set;
  const disabled = value.split(",").map((s) => s.trim()).filter(Boolean);
  for (const id of OPTIONAL_MODULE_IDS) if (disabled.includes(id)) set.delete(id);
  return set;
});

/** Convenience: is a single module switched on for this install? */
export async function isModuleEnabled(id: ModuleId): Promise<boolean> {
  return (await getEnabledModuleIds()).has(id);
}

/**
 * Server-side gate for actions and route handlers that throw on failure. Render-
 * time gating (only showing a button when a pack is on) is NOT a security
 * boundary — the action ID is still reachable by a direct POST — so every
 * module-owned mutation must call this too. Throws when the module is off; the
 * error surfaces to the caller exactly like an auth failure (`throw new Error`).
 */
export async function requireModuleEnabled(id: ModuleId): Promise<void> {
  if (!(await isModuleEnabled(id))) {
    throw new Error(`Module "${id}" is disabled`);
  }
}

/** Persist module choices as the disabled set (mandatory core can never be disabled). */
export async function setEnabledModuleIds(enabledIds: string[]): Promise<void> {
  const disabled = OPTIONAL_MODULE_IDS.filter((id) => !enabledIds.includes(id));
  await putSetting(SETTING_KEY, disabled.join(","));
}
