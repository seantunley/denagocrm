import { Prisma } from "@prisma/client";

/**
 * WHO OWNS A PIPELINE, AND WHO OWNS ITS STAGES.
 *
 * Extracted so the decision can be EXECUTED by a test rather than pattern-matched
 * against `pipelines.ts`. That file reaches `./db` and `server-only` transitively,
 * and `server-only` cannot be imported from `node:test`; this module imports only
 * the `Prisma` SQL tag, which needs no client and no DATABASE_URL. Every rule here
 * is a pure function of its arguments — no session, no request context — so
 * `tests/pipelineTenantIsolation.test.ts` can drive it with two concrete tenant ids
 * and assert that tenant B's row is unreachable from tenant A.
 *
 * ─── WHICH TABLES THIS GOVERNS ─────────────────────────────────────────────
 *
 * `SalesPipeline` and `PipelineStage` were the first two. The FORECAST family is
 * now here as well, because it is read by the same module through the same raw
 * `basePrisma` statements and had no boundary of its own:
 *
 *   `Lead`             — the forecast opportunity list AND the totals derived
 *                        from it (`listForecastLeads` → `summarizeForecast`)
 *   `ForecastSnapshot` — those totals once PERSISTED, and the history list
 *   `Team`             — the team a lead's forecast may be attached to
 *
 * Strict equality is safe on every one of them for the same measured reason it is
 * safe on the two originals — each was backfilled UNCONDITIONALLY, so no legacy
 * unowned row exists to be stranded:
 *
 *   `Lead`             20260722120000_tenant_people_isolation, and again by
 *                      20260809200000_lead_external_id_tenant_scope
 *   `Team`             20260725160000_tenant_governance_isolation
 *   `ForecastSnapshot` 20260725160000_tenant_governance_isolation
 *
 * and each has a live writer that stamps a real owner rather than the dormant
 * `writeTenantId()` null: teams through `createTeam` in accessControl.ts, which
 * refuses outright without an active tenant, and snapshots through
 * `captureForecastSnapshot` in pipelines.ts, which stamps `actingTenantId()`.
 */

/**
 * The column the predicate names, as a CLOSED SET of literals.
 *
 * Spliced with `Prisma.raw` — so it must never widen to `string`. The bare form is
 * for single-table statements; the prefixed forms name the alias each joined query
 * gives the table that actually carries the boundary (`p` SalesPipeline, `l` Lead,
 * `fs` ForecastSnapshot). Naming the wrong side of a join is the failure this type
 * exists to prevent: the forecast query joins SalesPipeline, PipelineStage, User and
 * Team onto Lead, and only `l."tenantId"` bounds which deals are summed.
 */
export type TenantScopeAlias = '"tenantId"' | 'p."tenantId"' | 'l."tenantId"' | 'fs."tenantId"';

/** The resolved read/write boundary for one caller's SalesPipeline queries. */
export type PipelineScope = {
  /** The acting workspace. Rows belong to this tenant and no other. */
  tenantId: string;
  /**
   * Whether rows with a NULL `tenantId` count as this tenant's. ALWAYS false —
   * see {@link pipelineScopeFor}. Kept as an explicit field so the rule is a
   * value a test can assert on, not an absence a test cannot see.
   */
  includeUnowned: boolean;
};

/**
 * STRICT EQUALITY. A NULL `tenantId` belongs to NOBODY.
 *
 * The obvious rule — "the founding tenant also owns the legacy `tenantId IS NULL`
 * rows" — is what `statistics.tenantSql` and `flowTenantScope.legacyFlowTenant`
 * do, and it was sound for those models when it was written. It is NOT sound for
 * SalesPipeline or PipelineStage today, because there are no legacy NULL rows left
 * to own:
 *
 *   - `PipelineStage` was backfilled to `tenant_denago_cpt` by migration
 *     20260722130000_tenant_sales_isolation;
 *   - `SalesPipeline` was backfilled to `tenant_denago_cpt` by migration
 *     20260725160000_tenant_governance_isolation.
 *
 * Both backfills are `UPDATE ... SET "tenantId" = 'tenant_denago_cpt' WHERE
 * "tenantId" IS NULL` — unconditional over the whole table. So every row that
 * predates tenancy is already owned, and a NULL row TODAY can only have been
 * created AFTER its backfill, by exactly the two bugs this branch is fixing:
 * `createPipeline` stamping no tenantId at all, and `addPipelineStage` stamping
 * `writeTenantId()`, which is null while enforcement is dormant.
 *
 * Which means a NULL row is not "old", it is "created by an unknown workspace" —
 * quite possibly tenant B's. Handing it to the founding tenant is not a
 * compatibility shim, it is a misattribution, and the direction that matters:
 * a strict filter makes an unowned row invisible, which is recoverable; a
 * permissive one makes another workspace's row EDITABLE, which is not.
 *
 * This is the same posture `journeyTenant.ts` already argues for, for the same
 * reason ("legacy rows were backfilled ... so nothing real is skipped").
 *
 * NOTHING IS STRANDED BY REMOVING IT, and that is measured rather than assumed:
 * the read-only production audit in PREFLIP-TENANT-AUDIT.md §3 counted **zero**
 * unowned rows on both `SalesPipeline` and `PipelineStage`. So there is no data
 * relying on the fallback, no backfill to write, and no owner to guess at.
 *
 * Honest caveat: production has exactly ONE tenant today, so no cross-tenant
 * misattribution can have happened yet. The rule was unsafe for the future, not
 * broken in the past — which is precisely why it is cheap to delete now and a
 * forensics exercise once a second workspace is writing rows.
 */
export function pipelineScopeFor(input: {
  /** `actingTenantId()` — the workspace the current staff user is acting in. */
  actingTenantId: string;
}): PipelineScope {
  return { tenantId: input.actingTenantId, includeUnowned: false };
}

/**
 * Whether a row with `rowTenantId` is inside `scope`. The reference implementation
 * of the SQL {@link pipelineScopeSql} emits, so a test can drive real rows through
 * the same decision the database applies.
 */
export function pipelineRowVisible(rowTenantId: string | null, scope: PipelineScope): boolean {
  if (rowTenantId === null || rowTenantId === undefined) return scope.includeUnowned;
  return rowTenantId === scope.tenantId;
}

/**
 * The tenant predicate for a raw SalesPipeline statement, built FROM the scope
 * above so the SQL cannot drift from the rule. `alias` names the column and is
 * spliced with `Prisma.raw`, so it is a closed set of literals, never user input.
 */
export function pipelineScopeSql(scope: PipelineScope, alias: TenantScopeAlias = '"tenantId"'): Prisma.Sql {
  const column = Prisma.raw(alias);
  return scope.includeUnowned
    ? Prisma.sql`AND (${column} = ${scope.tenantId} OR ${column} IS NULL)`
    : Prisma.sql`AND ${column} = ${scope.tenantId}`;
}

/**
 * The tenant a PipelineStage is stamped with: ITS PARENT PIPELINE'S, never the
 * acting tenant's and never `writeTenantId()`.
 *
 *   - `writeTenantId()` returns null while enforcement is dormant — which is
 *     today — so a stage created from a real workspace's UI was born unowned and
 *     goes invisible to that workspace the moment enforcement flips on. That is
 *     the bug this replaces.
 *   - `actingTenantId()` is right for the PIPELINE (the acting workspace is the
 *     one creating it) and wrong for the STAGE, because the two differ whenever
 *     an operator edits a pipeline their acting workspace does not own. A stage
 *     stamped with the editor's tenant instead of the pipeline's would split a
 *     pipeline's stages across two owners — the composite `(tenantId, id)` key
 *     on PipelineStage exists precisely to make that shape a lie.
 *
 * A stage belongs to its pipeline. Full stop. The caller must have loaded that
 * pipeline THROUGH {@link pipelineScopeSql} first, so the value returned here is
 * already inside the caller's boundary.
 */
export function stageTenantId(input: {
  /** `SalesPipeline.tenantId` of the parent, as loaded through the scoped read. */
  pipelineTenantId: string | null;
  /** The acting workspace — present so the wrong answer is expressible, and tested. */
  actingTenantId: string;
}): string | null {
  void input.actingTenantId;
  return input.pipelineTenantId;
}

/**
 * THE ONE SENTENCE for a stage id this workspace cannot act on.
 *
 * It is a constant rather than two string literals because the two cases it covers
 * MUST NOT be told apart, and two literals drift:
 *
 *   - the stage does not exist;
 *   - the stage exists, in somebody else's workspace.
 *
 * `moveStage` used to answer those differently. It resolved the stage on an
 * unscoped read first and only then called the ownership gate, so a foreign id got
 * as far as `throw new Error("Pipeline not found")` — which `asActionResult`
 * renders as the generic "did not complete cleanly" plus a reference code — while
 * an id that existed nowhere was refused one line earlier and rendered verbatim.
 * The read's VALUE never escaped; the BRANCH did, and one distinguishable bit is
 * all an existence oracle needs. `resolveStageParent` below removes the branch by
 * making both cases the same empty result, and this is what the caller is told in
 * either case.
 *
 * Deliberately the "no longer exists" wording rather than something hedged: for a
 * workspace that cannot reach the row, that is not a lie, and any sentence that
 * hinted at "exists, but not yours" would hand back the bit this exists to remove.
 */
export const UNREACHABLE_STAGE_MESSAGE = "That stage no longer exists — reload the page.";

/**
 * One row of the stage → parent-pipeline join, as the database holds it.
 *
 * `PipelineStage` cannot answer the ownership question about itself: its own
 * `tenantId` is NULL on every row written while enforcement was dormant, so a
 * predicate on it would refuse legitimate work. The parent pipeline is what carries
 * a real owner, which is why the boundary is applied to the JOINED row.
 */
export type StageParentRow = {
  stageId: string;
  pipelineId: string;
  /** `SalesPipeline.tenantId` — the owner that decides this. */
  pipelineTenantId: string | null;
  pipelineActive: boolean;
  /** `SalesPipeline.deletedAt IS NOT NULL`. Archived parents are not reachable. */
  pipelineDeleted: boolean;
};

/**
 * Resolve a stage id to its OWNING pipeline, or to nothing.
 *
 * The reference implementation of the single statement
 * `findOwnedPipelineForStage()` runs, so a test can drive real rows from two
 * workspaces through the same decision the database applies, rather than asserting
 * that a `${scope}` appears somewhere in a query.
 *
 * The property that matters is not "tenant B's stage is refused" — the old code
 * refused it too, eventually. It is that a stage id from another workspace and a
 * stage id from nowhere produce the SAME value here: `null`. There is no third
 * answer for a caller to measure.
 */
export function resolveStageParent(
  stageId: string,
  rows: readonly StageParentRow[],
  scope: PipelineScope,
): { id: string; tenantId: string | null; active: boolean } | null {
  const row = rows.find(
    (candidate) =>
      candidate.stageId === stageId &&
      !candidate.pipelineDeleted &&
      pipelineRowVisible(candidate.pipelineTenantId, scope),
  );
  if (!row) return null;
  return { id: row.pipelineId, tenantId: row.pipelineTenantId, active: row.pipelineActive };
}
