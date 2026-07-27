import { isTenantForeignKeyViolation } from "./tenant";

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
 * tenant blocked, DB access confined to the caller's tenant via the app-layer guard
 * (scopeArgs in db.ts), and Postgres RLS SET LOCAL injection active.
 *
 * Reads TENANT_ENFORCEMENT env var: returns true only when set to "enforce".
 * Both RLS (migration 20260727130000) and composite FKs (20260727140000) must be
 * live in the target database before flipping this on.
 *
 * Rollback: set TENANT_ENFORCEMENT back to "monitor" or "off" — the app guard
 * and RLS injection disable; FORCE RLS policies still exist in Postgres but the
 * app will set bypass_rls='on' (via basePrisma) or current_tenant (via prisma)
 * before queries, so no data is hidden.
 */
export function tenantEnforcing(): boolean {
  if (enforceOverrideForTests !== null) return enforceOverrideForTests;
  return tenantMode() === "enforce";
}

/**
 * Whether a failed `UserSession` insert may be retried WITHOUT a tenant (the
 * concurrent-tenant-deletion fallback in createSessionCookie). A broken tenant FK
 * is recoverable that way ONLY when NOT enforcing; under enforcement a tenant-less
 * authenticated session must never be issued, so the error propagates and login
 * aborts instead. Pure + unit-testable.
 */
export function mayRetryTenantlessSession(error: unknown, tenantId: string | null): boolean {
  return !tenantEnforcing() && isTenantForeignKeyViolation(error, tenantId);
}
