import { DEFAULT_TENANT_ID } from "./tenant";

/**
 * WHICH WORKSPACE OWNS A ROW whose `tenantId` is still nullable.
 *
 * `BotFlow`, `Journey` and `LibraryDocument` all predate tenancy, so their
 * `tenantId` column is NULL for every row an existing single-tenant install
 * already has. Filtering them with a bare `tenantId = $1` would therefore hide
 * a live business's entire flow library, and filtering them with nothing at all
 * — which is what the builder did — shows one workspace another workspace's
 * flows the moment a second tenant exists, because `tenantEnforcing()` is false
 * in production and the db.ts guard only scopes queries when it is true.
 *
 * The platform already has an answer to that, written down in statistics.ts
 * (`tenantSql`) and implemented for the chatbot runtime in flowPublishing.ts:
 * THE FOUNDING TENANT OWNS THE NULL ROWS, and no other tenant ever matches one.
 * That is not a loophole — `withTenantWrite()` resolves an un-owned write to
 * `DEFAULT_TENANT_ID` for the same reason, and every tenant-isolation migration
 * backfilled NULL rows to it. Once the backfill is complete the OR arm matches
 * nothing and this collapses to plain strict equality.
 *
 * Kept dependency-free (only the pure `./tenant` constants) so the rule can be
 * EXECUTED by a test rather than inferred from a regex over the call sites, in
 * the shape botOwnership.ts / botLease.ts use.
 */

/**
 * A Prisma `where` fragment. Two shapes on purpose, so a reader of a query can
 * see at a glance which half of the rule applied to it.
 */
export type NullableTenantWhere =
  | { tenantId: string }
  | { OR: [{ tenantId: string }, { tenantId: null }] };

/**
 * THE RULE, as a predicate over one row. Everything else here is derived from it.
 *
 *   - a row stamped with a tenant belongs to that tenant, and only to it;
 *   - an UNSTAMPED (NULL) row belongs to the founding tenant, and only to it.
 *
 * The second clause is the whole point: it keeps a legacy single-tenant install
 * working unchanged while making it impossible for a second workspace to absorb
 * the founding tenant's un-owned history.
 */
export function ownsNullableTenantRow(
  tenantId: string,
  rowTenantId: string | null,
  foundingTenantId: string = DEFAULT_TENANT_ID,
): boolean {
  return rowTenantId === null ? tenantId === foundingTenantId : rowTenantId === tenantId;
}

/**
 * The same rule as a query fragment, DERIVED from the predicate above rather
 * than restated beside it — the NULL arm is present exactly when the predicate
 * says this tenant owns NULL rows, so the two cannot drift apart.
 *
 * Written as an OR of two index-friendly terms rather than
 * `COALESCE(tenantId, …) = $1`, which is not sargable and would defeat the
 * `@@index([tenantId])` these models carry.
 */
export function nullableTenantWhere(
  tenantId: string,
  foundingTenantId: string = DEFAULT_TENANT_ID,
): NullableTenantWhere {
  return ownsNullableTenantRow(tenantId, null, foundingTenantId)
    ? { OR: [{ tenantId }, { tenantId: null }] }
    : { tenantId };
}
