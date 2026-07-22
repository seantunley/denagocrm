// Rollout switch for multi-tenancy enforcement. Three phases, controlled by the
// TENANT_ENFORCEMENT env var so it can be flipped per-environment (preview before
// prod) with no deploy:
//   - "off"     (default) — no tenant behaviour at all; the app is exactly as it
//                was pre-tenancy.
//   - "monitor" — observe only: log where tenant context is missing/inconsistent
//                (e.g. a login that can't resolve a single active tenant) so the
//                blast radius of enforcement is known BEFORE flipping it on.
//                Never blocks anything.
//   - "enforce" — accepted for forward-config, but currently OBSERVE-ONLY: it
//                behaves EXACTLY like "monitor" and blocks nothing. Real blocking
//                (requests without a valid tenant rejected) depends on per-table
//                tenantId + Postgres RLS, which is not built yet and lands in a
//                dedicated later PR. Gate future blocking on tenantEnforcing() —
//                the single hook that PR flips — so no caller silently assumes
//                "enforce" protects anything today.
//
// Pure + env-free parsing so it's unit-testable; tenantMode() reads the env.

export type TenantMode = "off" | "monitor" | "enforce";

export function parseTenantMode(raw: string | undefined | null): TenantMode {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "monitor":
      return "monitor";
    case "enforce":
      return "enforce";
    default:
      return "off"; // anything unrecognised (incl. unset) fails safe to off
  }
}

export function tenantMode(): TenantMode {
  return parseTenantMode(process.env.TENANT_ENFORCEMENT);
}

/** True when we should observe/log tenant issues (monitor or enforce). */
export function tenantObserving(): boolean {
  return tenantMode() !== "off";
}

// Test-only override for tenantEnforcing(). Lets the tenant-guard integration
// tests exercise the REAL Prisma extension with enforcement enabled, instead of
// the guard being permanently untestable behind a literal `false`. Never settable
// in production (the setter throws), and defaults to null so every real
// environment still gets `false`.
let enforceOverrideForTests: boolean | null = null;

/**
 * TEST ONLY. Enable/disable the enforcement branch for the current test process,
 * or pass null to clear. Throws in production so a stray call can never flip
 * enforcement on in the live app.
 */
export function __setTenantEnforcingForTests(value: boolean | null): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("__setTenantEnforcingForTests is not available in production");
  }
  enforceOverrideForTests = value;
}

/**
 * True when tenant context should actually be ENFORCED — requests without a valid
 * tenant blocked and DB access confined to the caller's tenant.
 *
 * Deliberately ALWAYS false in every real environment today. The app guard is
 * DEFENCE-IN-DEPTH: it scopes top-level ops and REFUSES nested relation writes
 * (fail closed), but it cannot validate a direct child's scalar parent FK. The
 * AUTHORITATIVE boundaries are Postgres RLS (row-level) and tenant-aware COMPOSITE
 * FKs (cross-row parent/child), and BOTH are HARD PREREQUISITES — this must not
 * flip to true in any environment (preview included) until RLS *and* composite FKs
 * are live (see PHASE-C-TENANT-GUARD-DESIGN.md §1.3/§1.5/§2/§5/§6). This is the
 * SINGLE hook the future enforcement PR flips; callers that must eventually block
 * gate on it now.
 */
export function tenantEnforcing(): boolean {
  if (enforceOverrideForTests !== null) return enforceOverrideForTests;
  return false;
}
