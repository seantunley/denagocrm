import "server-only";
import { currentScopeClass } from "./tenantWrite";
import { TenantScopeError } from "./tenantGuard";

/**
 * Namespace a service-booking OTP challenge by the AUTHENTICATED tenant.
 *
 * `OtpChallenge` is a GLOBAL model (no `tenantId` column — it's in the guard's
 * allow-list), and the service-lookup flow keys it by `purpose = "service-booking"`
 * + `key = VIN`. With a bare VIN key, under enforcement a code issued for tenant A's
 * VIN would share one global challenge with tenant B's request for the same VIN:
 * A could rate-limit, invalidate, or (once VIN uniqueness becomes tenant-scoped and
 * the same VIN can exist in two tenants) let a code issued to A be submitted with
 * B's key. Folding the tenant into the `key` isolates the whole lifecycle —
 * issue / flood-count / invalidate / verify / consume — per tenant.
 *
 * DORMANT / trusted `system` scope → the bare VIN, byte-for-byte the legacy key, so
 * existing challenges and the dormant legacy-global-key path keep working.
 * CLOSED (enforcement on, no resolvable tenant) → throws: an unauthenticated caller
 * must never mint or match a globally-keyed challenge. The route has already
 * authenticated + established scope before this is reached, so this is defence in
 * depth.
 */
export function serviceOtpKey(vin: string): string {
  const s = currentScopeClass();
  if (s.mode === "closed") {
    throw new TenantScopeError("No tenant scope established for a service OTP challenge");
  }
  return s.mode === "tenant" ? `t:${s.tenantId}:${vin}` : vin;
}
