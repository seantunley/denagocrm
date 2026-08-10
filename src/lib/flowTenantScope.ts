import { DEFAULT_TENANT_ID } from "./tenant";

/**
 * Which tenant owns a `BotFlow` row — the ONE rule, for reads and for writes.
 *
 * `BotFlow` predates tenancy and its `tenantId` is still NULLABLE. Migration
 * 20260722146000 backfilled the rows that existed on the day it ran, and nothing
 * has stamped a tenant since: while enforcement is dormant the db.ts guard writes
 * no tenantId at all, so every flow created after that migration is `NULL`.
 *
 * A STRICT `{ tenantId }` filter therefore does not mean "this tenant's flows" —
 * it means "flows that happened to exist in July". The read path already knew
 * this; the publish transaction filtered strictly anyway and could not find the
 * draft it was about to publish, so Publish did nothing at all.
 *
 * The founding tenant owns the NULL rows — the same rule statistics.ts applies,
 * and for the same reason. A second tenant sees only rows explicitly stamped as
 * its own, so tolerating legacy NULLs never widens anyone else's view.
 *
 * Kept import-free (only the pure `tenant` constants) so the rule can be executed
 * by a test rather than inferred from a regex over a module that talks to Prisma.
 */
export type FlowTenantWhere =
  | { tenantId: string }
  | { OR: [{ tenantId: string }, { tenantId: null }] };

/** Does `tenantId` own a BotFlow row whose stored tenant is `rowTenantId`? */
export function flowTenantOwns(tenantId: string, rowTenantId: string | null): boolean {
  if (rowTenantId === null) return tenantId === DEFAULT_TENANT_ID;
  return rowTenantId === tenantId;
}

/**
 * The same rule expressed as a Prisma `where` fragment. Spread it into every
 * BotFlow `where`, on the read path AND the write path, so the two cannot drift:
 * a reader that returns a row a writer then refuses to update is the defect this
 * module exists to prevent.
 */
export function flowTenantWhere(tenantId: string): FlowTenantWhere {
  return tenantId === DEFAULT_TENANT_ID ? { OR: [{ tenantId }, { tenantId: null }] } : { tenantId };
}
