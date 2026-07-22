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

/**
 * True when tenant context should actually be ENFORCED — requests without a valid
 * tenant blocked. Deliberately ALWAYS false today: enforcement depends on
 * per-table tenantId + Postgres RLS, which is not built yet, so even "enforce"
 * mode only observes. This is the SINGLE hook a future enforcement PR flips;
 * callers that must eventually block should gate on this now so nothing changes
 * behaviour until enforcement is real.
 */
export function tenantEnforcing(): boolean {
  return false;
}
