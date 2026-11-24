import "server-only";
import { cache } from "react";
import { actingTenantId } from "@/lib/actingTenant";
import { getEnabledModuleIds } from "@/lib/modules/enabled";
import { getWorkspaceSetting } from "@/lib/settings";
import { DEAL_LIFECYCLE_KEY, lifecycleFor, lifecycleTemplate } from "./dealLifecycle";

/** This workspace's chosen template (Automotive until an owner picks another). */
export const getLifecycleTemplate = cache(async () =>
  lifecycleTemplate(await getWorkspaceSetting(await actingTenantId(), DEAL_LIFECYCLE_KEY).catch(() => null)),
);

/** The lifecycle in force for this workspace, once per request. */
export const getDealLifecycle = cache(async () => lifecycleFor(await getLifecycleTemplate(), await getEnabledModuleIds()));
