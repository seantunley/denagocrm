import { Prisma } from "@prisma/client";

/**
 * WHO OWNS A ROW THE REPORTING ROLLUP AGGREGATES.
 *
 * Extracted so the decision can be EXECUTED by a test rather than pattern-matched
 * against `statistics.ts`. That file starts with `import "server-only"` and pulls
 * in a live PrismaClient, and `server-only` cannot be imported from `node:test`;
 * this module imports only the `Prisma` SQL tag, which needs no client and no
 * DATABASE_URL. Every rule here is a pure function of its arguments — no session,
 * no request context — so `tests/statisticsTenantIsolation.test.ts` can drive it
 * with two concrete tenant ids and assert that tenant B's row is unreachable from
 * tenant A.
 *
 * Same shape, and deliberately the same shape, as `pipelineTenantRule.ts`.
 *
 * ─── WHICH MODELS THIS GOVERNS ─────────────────────────────────────────────
 *
 * The two SOURCE tables the rollup aggregates, and only those:
 *
 *   `Lead`     — leads_created, deals_won, deals_lost
 *   `JobCard`  — jobcards_completed
 *
 * `StatisticBucket` and `StatisticCursor` are NOT in scope here. Their `tenantId`
 * is NOT NULL (migration 20260804120000 widens, backfills, then narrows it), so
 * they are read with plain strict equality and always were.
 */

/** The resolved read boundary for one rollup's source aggregates. */
export type StatisticsScope = {
  /** The tenant this rollup reads and writes as. Rows belong to it and no other. */
  tenantId: string;
  /**
   * Whether rows with a NULL `tenantId` count as this tenant's. ALWAYS false —
   * see {@link statisticsScopeFor}. Kept as an explicit field so the rule is a
   * value a test can assert on, not an absence a test cannot see.
   */
  includeUnowned: boolean;
};

/**
 * STRICT EQUALITY, FOR EVERY TENANT INCLUDING THE FOUNDING ONE. A NULL
 * `tenantId` belongs to NOBODY.
 *
 * This file used to carry the opposite rule, and the reasoning was sound when it
 * was written: source tables still held legacy un-owned rows, the db.ts guard
 * stamps nothing while enforcement is dormant, and a bare `= $1` would therefore
 * have reported a live business as having zero of everything. So the founding
 * tenant also claimed `tenantId IS NULL`.
 *
 * THAT PREMISE EXPIRED. Both source tables were backfilled unconditionally:
 *
 *   - `Lead`    by 20260722120000_tenant_people_isolation
 *     (`UPDATE "Lead" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL`)
 *   - `JobCard` by 20260722142000_tenant_workshop_isolation
 *     (the same statement, against "JobCard")
 *
 * Every row that predates tenancy is therefore already owned, and a NULL row
 * TODAY can only have been written AFTER its backfill, by a live code path. Which
 * means such a row is not "old", it is "created by an unknown workspace" — quite
 * possibly a second tenant's. Handing it to the founding tenant would not be a
 * compatibility shim, it would be a misattribution, and in an aggregation it is
 * the quietest kind there is: no foreign record appears on screen, just two
 * businesses' deals summed into one number.
 *
 * The direction matters. A strict filter makes an un-owned row invisible, which
 * is recoverable — stamp the row and it comes back. A permissive one folds
 * another workspace's revenue into the founding tenant's reports, which is not
 * detectable after the fact.
 *
 * NOTHING IS STRANDED BY REMOVING IT, and that is measured rather than assumed:
 * the read-only production audit in PREFLIP-TENANT-AUDIT.md §1 enumerates every
 * table holding an un-owned row, and NEITHER `Lead` NOR `JobCard` is among them.
 * Zero rows relied on the fallback, so there is no backfill to write and no owner
 * to guess at. (The audit does list `Quote` 1, `QuoteItem` 11 and `QuoteFee` 3 —
 * none of which this rollup reads.)
 *
 * Honest caveat, the same one #457 recorded: production has exactly ONE tenant
 * today, so no cross-tenant misattribution can have happened yet. The rule was
 * unsafe for the future, not broken in the past — which is precisely why it is
 * cheap to delete now and a forensics exercise once a second workspace is writing
 * rows.
 *
 * This is the posture `journeyTenant.ts` and `pipelineTenantRule.ts` already
 * take, for the same reason, and it is now the only posture in the reporting
 * path.
 */
export function statisticsScopeFor(input: {
  /** `statisticsTenantId()` — the tenant this rollup slice runs as. */
  tenantId: string;
}): StatisticsScope {
  return { tenantId: input.tenantId, includeUnowned: false };
}

/**
 * Whether a source row with `rowTenantId` is inside `scope`. The reference
 * implementation of the SQL {@link statisticsScopeSql} emits and the `where`
 * fragment {@link statisticsScopeWhere} builds, so a test can drive real rows
 * through the same decision the database applies.
 */
export function statisticsRowVisible(
  rowTenantId: string | null | undefined,
  scope: StatisticsScope,
): boolean {
  if (rowTenantId === null || rowTenantId === undefined) return scope.includeUnowned;
  return rowTenantId === scope.tenantId;
}

/**
 * The tenant predicate for the raw SOURCE aggregates, built FROM the scope above
 * so the SQL cannot drift from the rule.
 *
 * It has to be written out by hand at all because `$queryRaw` and `basePrisma`
 * BOTH BYPASS the tenant extension, and the aggregate uses both — raw because
 * Prisma cannot group by a date expression, `basePrisma` because raw calls on the
 * scoped client set no RLS GUC at all. THE PREDICATE IS APPLIED WHETHER OR NOT
 * ENFORCEMENT IS ON, which is the whole point: `activeTenantPredicate()`
 * deliberately returns no filter when enforcement is off, and the db.ts guard
 * adds nothing either, so a rollup that leaned on them would read completely
 * unscoped in the mode every deployment actually runs in today.
 *
 * Sargable by construction: one indexable equality term, which is what the
 * tenant-leading indexes in migration 20260804120000 were built for. The old
 * founding-tenant form was an OR that Postgres served as a BitmapOr of two scans;
 * dropping it is a small win as well as a correctness one.
 */
export function statisticsScopeSql(scope: StatisticsScope): Prisma.Sql {
  return scope.includeUnowned
    ? Prisma.sql`AND ("tenantId" = ${scope.tenantId}::text OR "tenantId" IS NULL)`
    : Prisma.sql`AND "tenantId" = ${scope.tenantId}::text`;
}

/**
 * The same rule as {@link statisticsScopeSql}, as a Prisma `where` fragment, for
 * the change-detection probe — which reads `basePrisma.lead` / `basePrisma.jobCard`
 * through the client rather than as raw SQL, and must watch exactly the rows the
 * aggregate counts. If the probe and the aggregate disagreed about ownership, a
 * change to a row one of them can see and the other cannot would either never be
 * noticed or be recomputed for ever.
 */
export function statisticsScopeWhere(scope: StatisticsScope): { tenantId: string } | {
  OR: Array<{ tenantId: string | null }>;
} {
  return scope.includeUnowned
    ? { OR: [{ tenantId: scope.tenantId }, { tenantId: null }] }
    : { tenantId: scope.tenantId };
}
