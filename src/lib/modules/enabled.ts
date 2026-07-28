import "server-only";
import { cache } from "react";
import { basePrisma, prisma } from "@/lib/db";
import { OPTIONAL_MODULE_IDS, type ModuleId } from "./registry";
import { effectiveModuleIds, installWideModuleIds } from "./entitlement";

// We persist the DISABLED optional packs, not the enabled ones. Storing the
// disabled set means a newly-added module defaults ON for every existing
// install (it simply isn't in anyone's disabled list yet) — so shipping a new
// pack never silently removes it from tenants who saved module settings before
// it existed. Unset = nothing disabled = every module on.
const SETTING_KEY = "DISABLED_MODULES";

/** The tenant's own "switched off" list — unchanged, pre-existing semantics. */
async function locallyDisabledIds(): Promise<string[]> {
  const row = await prisma.appSetting
    .findUnique({ where: { key: SETTING_KEY } })
    .catch(() => null);
  if (!row?.value) return [];
  return row.value.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Effective module ids for the CURRENT request.
 *
 * Two layers (see modules/entitlement.ts):
 *   - GRANT: `Tenant.modules`, set by a platform admin — what the tenant MAY use.
 *   - LOCAL DISABLE: the DISABLED_MODULES setting — what the tenant switched off.
 * Effective = granted MINUS locally disabled. Core is always included.
 *
 * WHEN NO TENANT RESOLVES (cron sweeps, public token routes, and every request
 * while tenant enforcement is dormant and sessions carry no usable `tid`) this
 * falls back to the pre-tenancy install-wide answer. That is deliberate: adding
 * entitlement must not change what today's single-tenant install sees. Once
 * enforcement is on and a tenant always resolves, the fallback stops being reached
 * for user requests.
 */
export const getEnabledModuleIds = cache(async (): Promise<Set<ModuleId>> => {
  const disabled = await locallyDisabledIds();

  const tenantId = await resolveTenantIdQuietly();
  if (!tenantId) return installWideModuleIds(disabled);

  // basePrisma: Tenant is a GLOBAL model, and this runs during rendering where a
  // tenant scope may not be established yet.
  const tenant = await basePrisma.tenant
    .findUnique({ where: { id: tenantId }, select: { modules: true } })
    .catch(() => null);
  // A tenant id that no longer resolves is treated as no tenant rather than as an
  // empty grant, so a transient lookup failure cannot black out the whole UI.
  if (!tenant) return installWideModuleIds(disabled);

  return effectiveModuleIds(tenant.modules, disabled);
});

/**
 * Resolve the acting tenant without letting auth failures break rendering.
 * `getActiveTenantId` reads cookies and the session registry; in a cron/system
 * context there is no request to read, which throws. Those callers legitimately
 * have no tenant, so treat any failure as "no tenant" and fall back.
 */
async function resolveTenantIdQuietly(): Promise<string | null> {
  try {
    const { getActiveTenantId } = await import("@/lib/auth");
    return await getActiveTenantId();
  } catch {
    return null;
  }
}

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
  const value = disabled.join(",");
  await prisma.appSetting.upsert({
    where: { key: SETTING_KEY },
    update: { value },
    create: { key: SETTING_KEY, value },
  });
}
