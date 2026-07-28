import "server-only";
import { cache } from "react";
import { basePrisma, prisma } from "@/lib/db";
import { currentTenantScope } from "@/lib/tenantScope";
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

  const resolution = await resolveTenantForModules();

  // No tenant anywhere: pre-tenancy install-wide behaviour (also the dormant path).
  if (resolution.kind === "none") return installWideModuleIds(disabled);
  // Trusted cross-tenant work legitimately spans tenants; no single grant applies.
  if (resolution.kind === "system") return installWideModuleIds(disabled);
  // A scope exists but names no tenant — FAIL CLOSED rather than widen access.
  if (resolution.kind === "scoped-but-unresolved") return effectiveModuleIds("", disabled);

  // Once a tenant is known this must FAIL CLOSED. Falling back to the install-wide
  // set here would turn a resolution or database failure into BROADER access than
  // the tenant was granted — the opposite of what a failure should do. A missing
  // row yields the empty grant (core only).
  //
  // Errors are deliberately NOT caught: a transient database failure should surface
  // as an error, not silently downgrade the UI and look like a config change.
  //
  // basePrisma: Tenant is a GLOBAL model, and this runs during rendering where a
  // tenant scope may not be established yet.
  const tenant = await basePrisma.tenant.findUnique({
    where: { id: resolution.tenantId },
    select: { modules: true },
  });

  return effectiveModuleIds(tenant?.modules ?? "", disabled);
});

/** How the acting tenant was determined, so the caller knows how to fail. */
type TenantResolution =
  | { kind: "tenant"; tenantId: string }
  /** Trusted cross-tenant work (backups, some cron) — no single tenant applies. */
  | { kind: "system" }
  /** A scope exists but names no tenant — fail CLOSED, never install-wide. */
  | { kind: "scoped-but-unresolved" }
  /** No scope and no staff session — pre-tenancy install-wide behaviour. */
  | { kind: "none" };

/**
 * Resolve the acting tenant for module gating.
 *
 * The EXPLICIT request scope is checked FIRST, and this matters: portal, public
 * token and background surfaces never carry a staff JWT — they establish a tenant
 * scope instead (establishTenantScopeFromId / withTokenTenantScope). Consulting
 * only the staff session would make those paths fall back to the install-wide set,
 * so a REVOKED grant would still be usable from the customer portal. The portal's
 * own automotive check (actions/portal.ts) is exactly such a caller.
 *
 * Only when no scope is bound do we fall back to the staff session. `getActiveTenantId`
 * reads cookies and the session registry, which throws where there is no request —
 * those callers legitimately have no tenant, so a failure means "none".
 */
async function resolveTenantForModules(): Promise<TenantResolution> {
  const scope = currentTenantScope();
  if (scope) {
    if (scope.system) return { kind: "system" };
    return scope.tenantId
      ? { kind: "tenant", tenantId: scope.tenantId }
      : { kind: "scoped-but-unresolved" };
  }

  try {
    const { getActiveTenantId } = await import("@/lib/auth");
    const tenantId = await getActiveTenantId();
    return tenantId ? { kind: "tenant", tenantId } : { kind: "none" };
  } catch {
    return { kind: "none" };
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
