import "server-only";
import crypto from "crypto";
import { basePrisma } from "./db";
import { getSetting } from "./settings";
import { tenantEnforcing } from "./tenantEnforcement";

// Per-tenant public API keys (intake / bookings / service-lookup), replacing the
// single global INTAKE_API_KEY. Keys are HASHED at rest (sha256 of the raw key);
// the raw key is shown once at creation. Lookups are raw SQL through basePrisma —
// TenantApiKey is a trusted infra table resolved BEFORE any tenant scope exists
// (the key IS what tells us the tenant), the same boundary as resolvePortalTenant /
// the token resolvers.

export function hashApiKey(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Resolve the owning tenant of a per-tenant API key for the given scope, or null.
 * Rejects unknown, revoked, and out-of-scope keys. Best-effort lastUsedAt stamp.
 */
export async function resolveApiKeyTenant(rawKey: string, scope: string): Promise<string | null> {
  if (!rawKey) return null;
  const hashedKey = hashApiKey(rawKey);
  const rows = await basePrisma.$queryRaw<{ id: string; tenantId: string; scopes: string }[]>`
    SELECT "id", "tenantId", "scopes" FROM "TenantApiKey"
    WHERE "hashedKey" = ${hashedKey} AND "revokedAt" IS NULL
    LIMIT 1`;
  const row = rows[0];
  if (!row) return null;
  if (!row.scopes.split(",").map((s) => s.trim()).includes(scope)) return null;
  void basePrisma
    .$executeRaw`UPDATE "TenantApiKey" SET "lastUsedAt" = ${new Date()} WHERE "id" = ${row.id}`
    .catch(() => {});
  return row.tenantId;
}

/**
 * Authenticate a public intake/bookings/service-lookup request by its X-Api-Key and
 * resolve the owning tenant. Returns `{ tenantId }` on success (tenantId is null in
 * the legacy dormant case), or null to reject with 401.
 *
 * - A per-tenant hashed key → its tenant (the new path; also matches the backfilled
 *   global key once registered).
 * - Under enforcement, ONLY a per-tenant key is accepted — the legacy global key is
 *   rejected, so an unregistered/tenant-less caller can't act.
 * - Dormant back-compat: the legacy global `INTAKE_API_KEY` setting still works
 *   (tenantId null), so intake keeps working before/independent of the backfill.
 *
 * The key resolution is raw SQL (no tenant scope needed), so the caller can
 * `establishTenantScopeFromId(auth.tenantId)` AFTER this returns — before any
 * guarded read.
 */
export async function authenticateIntakeKey(
  rawKey: string | null,
  scope: string,
): Promise<{ tenantId: string | null } | null> {
  const key = rawKey ?? "";
  if (!key) return null;
  const tenantId = await resolveApiKeyTenant(key, scope);
  if (tenantId) return { tenantId };
  if (tenantEnforcing()) return null; // enforcement: per-tenant keys only
  const legacy = await getSetting("INTAKE_API_KEY"); // dormant back-compat
  if (legacy && key === legacy) return { tenantId: null };
  return null;
}
