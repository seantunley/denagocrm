import { DEFAULT_TENANT_ID } from "./tenant";

/**
 * Which BotFlow rows a tenant may see and publish.
 *
 * BotFlow predates tenancy: its `tenantId` is nullable, and while the db.ts guard
 * is dormant nothing stamps it — so every flow created since the 20260722146000
 * backfill carries NULL. Filtering strictly would hide every flow an existing
 * install has, and on the publish path it did worse than hide them: the re-read
 * found nothing, threw FLOW_NOT_FOUND, and setActiveFlow swallowed that into
 * null. The operator clicked Publish and nothing happened — no audit, no error.
 *
 * So the founding tenant owns the NULL rows, which is the rule statistics.ts
 * already applies for the same reason. A second workspace sees only its own.
 *
 * Import-free so the rule can be executed by a test rather than pattern-matched:
 * flowPublishing.ts reaches server-only code and cannot be imported from one.
 */
export function legacyFlowTenant(tenantId: string): { tenantId: string } | { OR: Array<{ tenantId: string | null }> } {
  return tenantId === DEFAULT_TENANT_ID
    ? { OR: [{ tenantId }, { tenantId: null }] }
    : { tenantId };
}
