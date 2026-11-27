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
  // JOIN Tenant + require active=true: a key for a SUSPENDED tenant, or a DANGLING
  // key whose tenant was deleted, must not authenticate or establish a scope.
  const rows = await basePrisma.$queryRaw<{ id: string; tenantId: string; scopes: string }[]>`
    SELECT k."id", k."tenantId", k."scopes"
    FROM "TenantApiKey" k
    JOIN "Tenant" t ON t."id" = k."tenantId"
    WHERE k."hashedKey" = ${hashedKey} AND k."revokedAt" IS NULL AND t."active" = true
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

// ── A workspace's own keys, managed by its owner (Settings → Integrations) ────────
//
// Until now a key could only be made by scripts/backfill-tenant-api-keys.ts, for
// the founding workspace's old global key — so no other workspace could take
// leads from its website at all (Sean, 2026-11-27: "each workspace has to have
// their own details"). Every query below names the workspace: the table is read
// through basePrisma, before and outside any tenant scope, so nothing else would.

/** Public API scopes a workspace key may carry — the routes that call authenticateIntakeKey. */
export const API_KEY_SCOPES = ["intake", "bookings", "service-lookup"] as const;

/** A new raw key: unguessable, URL- and header-safe, recognisable by its prefix. */
export function generateApiKey(): string {
  return `dcrm_${crypto.randomBytes(32).toString("base64url")}`;
}

export type WorkspaceApiKey = {
  id: string;
  label: string;
  /** The first characters of the key, for telling keys apart. Never enough to use it. */
  prefix: string;
  scopes: string;
  createdAt: Date;
  lastUsedAt: Date | null;
};

/** The workspace's keys that still work, newest first. */
export async function listWorkspaceApiKeys(tenantId: string): Promise<WorkspaceApiKey[]> {
  return basePrisma.$queryRaw<WorkspaceApiKey[]>`
    SELECT "id", "label", "prefix", "scopes", "createdAt", "lastUsedAt"
    FROM "TenantApiKey"
    WHERE "tenantId" = ${tenantId} AND "revokedAt" IS NULL
    ORDER BY "createdAt" DESC`;
}

/** Make a key for this workspace. The raw key is returned ONCE; only its hash is kept. */
export async function createWorkspaceApiKey(tenantId: string, label: string): Promise<{ id: string; rawKey: string; prefix: string }> {
  const rawKey = generateApiKey();
  const id = crypto.randomUUID();
  const prefix = rawKey.slice(0, 12);
  await basePrisma.$executeRaw`
    INSERT INTO "TenantApiKey" ("id", "tenantId", "label", "hashedKey", "prefix", "scopes", "createdAt")
    VALUES (${id}, ${tenantId}, ${label}, ${hashApiKey(rawKey)}, ${prefix}, ${API_KEY_SCOPES.join(",")}, CURRENT_TIMESTAMP)`;
  return { id, rawKey, prefix };
}

/** Stop a key working, at once. Only this workspace's, only once. True when it was revoked now. */
export async function revokeWorkspaceApiKey(tenantId: string, id: string): Promise<boolean> {
  const count = await basePrisma.$executeRaw`
    UPDATE "TenantApiKey" SET "revokedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${id} AND "tenantId" = ${tenantId} AND "revokedAt" IS NULL`;
  return count === 1;
}
