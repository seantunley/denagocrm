import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/db";
import {
  ALL_MODULE_IDS,
  MANDATORY_MODULE_IDS,
  OPTIONAL_MODULE_IDS,
  type ModuleId,
} from "./registry";

// Which optional packs are switched on, stored as a CSV AppSetting. Unset = every
// module on (so existing installs are unaffected — Phase 1 is behaviour-preserving).
const SETTING_KEY = "ENABLED_MODULES";

/** Enabled module ids for this install. Mandatory (core) is always included. */
export const getEnabledModuleIds = cache(async (): Promise<Set<ModuleId>> => {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTING_KEY } }).catch(() => null);
  if (!row?.value) return new Set(ALL_MODULE_IDS);
  const stored = row.value.split(",").map((s) => s.trim()).filter(Boolean);
  const set = new Set<ModuleId>(MANDATORY_MODULE_IDS);
  for (const id of OPTIONAL_MODULE_IDS) if (stored.includes(id)) set.add(id);
  return set;
});

/** Persist the enabled optional modules (core is forced on regardless of input). */
export async function setEnabledModuleIds(ids: string[]): Promise<void> {
  const enabled = OPTIONAL_MODULE_IDS.filter((id) => ids.includes(id));
  const value = [...MANDATORY_MODULE_IDS, ...enabled].join(",");
  await prisma.appSetting.upsert({
    where: { key: SETTING_KEY },
    update: { value },
    create: { key: SETTING_KEY, value },
  });
}
