import {
  ALL_MODULE_IDS,
  MODULE_REGISTRY,
  OPTIONAL_MODULE_IDS,
  type ModuleId,
} from "./registry";

/**
 * PURE entitlement maths for per-tenant modules. No Prisma, no `server-only`, no
 * env reads — every branch is a plain function of its arguments, so the rules are
 * unit-testable without a database (same posture as tenantAdmin.ts).
 *
 * Two layers, deliberately distinct:
 *   - GRANT (Tenant.modules)      — what a tenant MAY use. Set by a platform admin.
 *   - LOCAL DISABLE (AppSetting)  — what the tenant's own admin switched off.
 *
 * Effective = granted MINUS locally disabled. A tenant can never switch on a pack
 * it was not granted, and the platform revoking a grant immediately removes the
 * module regardless of local preference.
 */

/** Module ids that are mandatory and can never be revoked. */
const MANDATORY_MODULE_IDS: ModuleId[] = MODULE_REGISTRY.filter(
  (module) => module.mandatory,
).map((module) => module.id);

/** Parse a stored CSV grant into known optional module ids, ignoring junk. */
export function parseModuleCsv(csv: string | null | undefined): Set<ModuleId> {
  const out = new Set<ModuleId>();
  if (!csv) return out;
  for (const raw of csv.split(",")) {
    const id = raw.trim();
    // Unknown ids are dropped rather than trusted: a stale grant naming a removed
    // module must not resurrect anything, and junk must not widen access.
    if ((OPTIONAL_MODULE_IDS as string[]).includes(id)) out.add(id as ModuleId);
  }
  return out;
}

/** Serialise a grant for storage — sorted and de-duplicated so diffs are stable. */
export function serialiseModuleGrant(ids: readonly string[]): string {
  const granted = new Set<string>();
  for (const id of ids) {
    if ((OPTIONAL_MODULE_IDS as string[]).includes(id)) granted.add(id);
  }
  return [...granted].sort().join(",");
}

/**
 * The set a tenant MAY use: its granted optional packs plus every mandatory one.
 * Mandatory modules are added unconditionally — `core` is not stored in the grant
 * and must never be revocable.
 */
export function grantedModuleIds(tenantModulesCsv: string | null | undefined): Set<ModuleId> {
  const set = new Set<ModuleId>(MANDATORY_MODULE_IDS);
  for (const id of parseModuleCsv(tenantModulesCsv)) set.add(id);
  return set;
}

/**
 * Effective modules for a tenant: granted, minus what the tenant disabled locally.
 * A locally-disabled id that was never granted is simply irrelevant.
 *
 * `locallyDisabled` uses the existing DISABLED_MODULES semantics (store what is
 * OFF), so a newly shipped pack is not silently disabled for anyone — it is
 * governed purely by whether the platform granted it.
 */
export function effectiveModuleIds(
  tenantModulesCsv: string | null | undefined,
  locallyDisabled: readonly string[],
): Set<ModuleId> {
  const effective = grantedModuleIds(tenantModulesCsv);
  for (const id of locallyDisabled) {
    const trimmed = id.trim();
    // Mandatory packs are never removable, however the setting is written.
    if ((MANDATORY_MODULE_IDS as string[]).includes(trimmed)) continue;
    effective.delete(trimmed as ModuleId);
  }
  return effective;
}

/**
 * What the DISABLED_MODULES setting should become after an owner saves the
 * Modules screen.
 *
 * THE FORM CANNOT SPEAK FOR PACKS IT DID NOT SHOW AS USABLE. An ungranted pack
 * renders as a DISABLED checkbox, and a disabled checkbox posts nothing — so
 * reading "absent from `picked`" as "the owner switched it off" invents a
 * decision the owner was never offered. Doing that wrote every ungranted pack
 * into the disable list the first time anyone pressed Save.
 *
 * The damage only appears later: when a platform admin ADDS the pack to the
 * grant, effective = granted MINUS disabled leaves it off, and the new grant
 * looks like it did not take — the same "the setting saved perfectly and the
 * module stayed off" confusion the screen was fixed to end.
 *
 * So each optional pack is decided by the layer that is entitled to decide it:
 *   - IN the grant      → the form's ticks are authoritative
 *   - OUTSIDE the grant → carry the stored state through untouched
 *
 * Consulting the grant here also means a hand-made POST cannot enable a pack the
 * tenant was never given: the omission is no longer what protects us.
 */
export function nextDisabledModuleIds(
  granted: ReadonlySet<string>,
  previouslyDisabled: readonly string[],
  picked: readonly string[],
): ModuleId[] {
  const wasDisabled = new Set(previouslyDisabled.map((id) => id.trim()));
  return OPTIONAL_MODULE_IDS.filter((id) =>
    granted.has(id) ? !picked.includes(id) : wasDisabled.has(id),
  );
}

/**
 * Behaviour for an install with NO resolvable tenant — cron sweeps, public token
 * routes, and every request while tenant enforcement is still dormant and sessions
 * carry no usable `tid`.
 *
 * Returns the pre-tenancy install-wide answer (everything except what is locally
 * disabled), so adding entitlement does not change what a single-tenant install
 * sees. Once enforcement is on and a tenant always resolves, this path stops being
 * reached for user requests.
 */
export function installWideModuleIds(locallyDisabled: readonly string[]): Set<ModuleId> {
  const set = new Set<ModuleId>(ALL_MODULE_IDS);
  for (const id of locallyDisabled) {
    const trimmed = id.trim();
    if ((OPTIONAL_MODULE_IDS as string[]).includes(trimmed)) set.delete(trimmed as ModuleId);
  }
  return set;
}
