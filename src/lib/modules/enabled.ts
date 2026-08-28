import "server-only";
import { cache } from "react";
import { basePrisma } from "@/lib/db";
import { getSetting, putSetting } from "@/lib/settings";
import { currentTenantScope } from "@/lib/tenantScope";
import { OPTIONAL_MODULE_IDS, type ModuleId } from "./registry";
import { effectiveModuleIds, grantedModuleIds, installWideModuleIds } from "./entitlement";

// We persist the DISABLED optional packs, not the enabled ones. Storing the
// disabled set means a newly-added module defaults ON for every existing
// install (it simply isn't in anyone's disabled list yet) — so shipping a new
// pack never silently removes it from tenants who saved module settings before
// it existed. Unset = nothing disabled = every module on.
const SETTING_KEY = "DISABLED_MODULES";

/**
 * The tenant's own "switched off" list.
 *
 * Read through `getSetting` rather than touching AppSetting directly. `key` is no
 * longer unique on its own — the table is keyed `(tenantId, key)` — so a bare
 * `findUnique({ where: { key } })` no longer compiles, and the equivalent upsert
 * emitted `ON CONFLICT (key)` against a constraint that does not exist (42P10).
 * `getSetting` resolves the owning tenant and uses the compound key, which is also
 * what makes this list genuinely per-tenant under enforcement.
 */
async function locallyDisabledIds(): Promise<string[]> {
  const value = await getSetting(SETTING_KEY).catch(() => null);
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
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
export async function getEnabledModuleIds(): Promise<Set<ModuleId>> {
  // Resolve the tenant FIRST, OUTSIDE the cache, then memoise keyed by the answer.
  //
  // This function used to be `cache(async () => ...)` with no arguments. React's
  // cache dedupes per REQUEST, and a zero-argument function has exactly one cache
  // entry — so a request that spans SEVERAL tenants (the automation cron sweeps
  // tenants in one request) computed the first tenant's modules and then handed
  // that same set to every later tenant. Harmless while the answer was
  // install-wide for everyone; a cross-tenant leak the moment it varies by tenant.
  //
  // Keying on the resolution keeps the per-request dedupe that render paths rely
  // on (this is called by many components per page) while making each distinct
  // tenant its own entry.
  const resolution = await resolveTenantForModules();
  const key =
    resolution.kind === "tenant" ? `tenant:${resolution.tenantId}` : resolution.kind;
  return modulesForResolution(key);
}

/**
 * The cached half. Keyed by a STRING so React's cache compares by value — passing
 * the resolution object would key on identity and never hit.
 */
const modulesForResolution = cache(async (key: string): Promise<Set<ModuleId>> => {
  // The local "switched off" list is itself tenant-scoped under enforcement
  // (AppSetting carries a tenantId), so it must be read INSIDE the keyed cache —
  // reading it outside would reintroduce the same cross-tenant bleed.
  const disabled = await locallyDisabledIds();

  // No tenant anywhere: pre-tenancy install-wide behaviour (also the dormant path).
  if (key === "none") return installWideModuleIds(disabled);
  // Trusted cross-tenant work legitimately spans tenants; no single grant applies.
  if (key === "system") return installWideModuleIds(disabled);
  // A scope exists but names no tenant — FAIL CLOSED rather than widen access.
  if (key === "scoped-but-unresolved") return effectiveModuleIds("", disabled);

  const tenantId = key.slice("tenant:".length);

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
    where: { id: tenantId },
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

/**
 * What this workspace MAY use — the grant, before its own on/off choices.
 *
 * ── WHY THE SETTINGS SCREEN NEEDS THIS AND NOTHING ELSE DOES ────────────────
 *
 * Everywhere else only cares whether a module is effective, and
 * `getEnabledModuleIds` answers that. Settings → Modules is different: it draws a
 * checkbox per module, and an ungranted module rendered as an unchecked box is a
 * control that cannot work. Ticking it saves correctly — the local disable list
 * is written — and the module stays off, because effective is grant MINUS
 * disabled and the grant never contained it. The box comes back unticked and it
 * reads as "saving is broken".
 *
 * That cost real time on 2026-08-28: the dev workspace was missing `automation`
 * from its grant, the pack could not be switched on, and the save was blamed.
 * The setting had written perfectly.
 *
 * FAILS CLOSED the same way the effective set does — an unresolved tenant yields
 * the mandatory modules only, never the install-wide list, so this can never
 * present a module as available that the tenant was not granted.
 */
export async function grantedModuleIdsForRequest(): Promise<Set<ModuleId>> {
  const resolution = await resolveTenantForModules();
  if (resolution.kind !== "tenant") {
    // No single tenant applies. `installWideModuleIds` is the honest answer for
    // the pre-tenancy and system paths, and grantedModuleIds("") is the
    // fail-closed answer for a scope that names nobody.
    return resolution.kind === "scoped-but-unresolved"
      ? grantedModuleIds("")
      : installWideModuleIds([]);
  }
  const tenant = await basePrisma.tenant.findUnique({
    where: { id: resolution.tenantId },
    select: { modules: true },
  });
  return grantedModuleIds(tenant?.modules ?? "");
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
  // Via putSetting for the same reason as the read: AppSetting is keyed
  // (tenantId, key), so a direct upsert on `key` alone emits ON CONFLICT (key) and
  // fails with 42P10 — which is exactly how saving module choices broke.
  await putSetting(SETTING_KEY, disabled.join(","));
}
