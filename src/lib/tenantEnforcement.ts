// Rollout switch for multi-tenancy enforcement. Three phases, controlled by the
// TENANT_ENFORCEMENT env var so it can be flipped per-environment (preview before
// prod) with no deploy:
//   - "off"     (default) — no tenant behaviour at all; the app is exactly as it
//                was pre-tenancy.
//   - "monitor" — observe only: log where tenant context is missing/inconsistent
//                (e.g. a login that can't resolve a single active tenant) so the
//                blast radius of enforcement is known BEFORE flipping it on.
//                Never blocks anything.
//   - "enforce" — (future phase) actually require a valid tenant. Not wired to
//                block yet; today it behaves like "monitor".
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
