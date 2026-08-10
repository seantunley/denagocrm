import { DEFAULT_TENANT_ID } from "./tenant";

/**
 * WHO OWNS A BotFlow, AND WHO OWNS A Journey.
 *
 * Import-free (only the founding-tenant constant, itself pure) so the rule can be
 * EXECUTED by a test rather than pattern-matched: `flowScope.ts` and
 * `flowPublishing.ts` both reach `server-only`, which cannot be imported from
 * `node:test`.
 *
 * ─── WHICH MODELS THIS GOVERNS ─────────────────────────────────────────────
 *
 *   `BotFlow` — every builder surface (`flowScope()`), the publish transaction's
 *               re-read/deactivate/activate, the version-history page and its
 *               restore action, and the runtime legacy fallback in
 *               `resolveFlowSnapshot`.
 *   `Journey` — the canvas Journey picker, the AI drafter's allow-list and the
 *               publication validator (`journeyScope()`).
 *
 * `BotFlowVersion` and `BotFlowPublication` are NOT in scope. Their `tenantId` is
 * NOT NULL — every row was written through `withTenantWrite` — so they are
 * filtered with plain strict equality and always were.
 */

/** The resolved read/write boundary for one builder request. */
export type FlowScope = {
  /** The acting workspace. Rows belong to this tenant and no other. */
  tenantId: string;
  /**
   * Whether rows with a NULL `tenantId` count as this tenant's. ALWAYS false —
   * see {@link flowScopeFor}. Kept as an explicit field so the rule is a value a
   * test can assert on, not an absence a test cannot see.
   */
  includeUnowned: boolean;
};

/**
 * STRICT EQUALITY, FOR EVERY TENANT INCLUDING THE FOUNDING ONE. A NULL
 * `tenantId` belongs to NOBODY.
 *
 * This module used to carry the opposite rule, and it was load-bearing when it
 * was written: `prisma.botFlow.create` stamped no tenant, the db.ts guard stamps
 * nothing while enforcement is dormant, so freshly created flows carried NULL —
 * and filtering strictly did worse than hide them. The publish transaction's
 * re-read found nothing, threw FLOW_NOT_FOUND, and `setActiveFlow` swallowed that
 * into null: the operator clicked Publish and NOTHING happened, no audit, no
 * error. So the founding tenant claimed the NULL rows.
 *
 * THAT PREMISE EXPIRED, in two steps.
 *
 * First the writers were fixed — both `botFlow.create` sites stamp
 * `await builderTenantId()`, the bot-builder list's first-run seed stamps it, and
 * `publishFlowSnapshot` re-stamps the flow it publishes. Nothing creates an
 * un-owned flow any more.
 *
 * Second, and decisively, both tables were backfilled unconditionally:
 *
 *   - `BotFlow` by 20260722146000_tenant_automation_isolation
 *     (`UPDATE "BotFlow" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL`)
 *   - `Journey` by 20260726200000_journey_tenant_isolation
 *     (the same statement, against "Journey")
 *
 * So every row that predates tenancy is already owned, and a NULL row TODAY can
 * only have been written AFTER its backfill — which makes it not "old" but
 * "created by an unknown workspace", quite possibly a second tenant's. Handing it
 * to the founding tenant would not be a compatibility shim, it would be a
 * misattribution; and for these two models it is the expensive kind, because the
 * rule governs WRITES as well as reads. `publishFlowSnapshot` deactivates
 * siblings and activates the winner through this very predicate, so a permissive
 * rule does not merely SHOW the founding tenant another workspace's flow — it
 * lets a publish take another workspace's live conversation graph off the air.
 *
 * NOTHING IS STRANDED BY REMOVING IT, and that is measured rather than assumed:
 * the read-only production audit in PREFLIP-TENANT-AUDIT.md §1 enumerates every
 * table holding an un-owned row, and NEITHER `BotFlow` NOR `Journey` is among
 * them. (`JourneyEvent` 10/11, `JourneyRun` 6/6 and `JourneyStepLog` 6/6 ARE —
 * but those are the engine's runtime tables, scoped by `journeyTenant.ts`, which
 * has always been strict. Nothing here reads them.) Zero rows relied on the
 * fallback, so there is no backfill to write and no owner to guess at.
 *
 * Honest caveat, the same one #457 recorded: production has exactly ONE tenant
 * today, so no cross-tenant misattribution can have happened yet. The rule was
 * unsafe for the future, not broken in the past.
 */
export function flowScopeFor(input: {
  /** `builderTenantId()` at a staff surface, `runtimeFlowTenantId()` at a webhook. */
  tenantId: string;
}): FlowScope {
  return { tenantId: input.tenantId, includeUnowned: false };
}

/**
 * Whether a row with `rowTenantId` is inside `scope`. The reference
 * implementation of the `where` fragment {@link flowTenantWhere} builds, so a
 * test can drive real rows through the same decision the database applies.
 */
export function flowRowVisible(rowTenantId: string | null | undefined, scope: FlowScope): boolean {
  if (rowTenantId === null || rowTenantId === undefined) return scope.includeUnowned;
  return rowTenantId === scope.tenantId;
}

/**
 * The `where` fragment scoping a BotFlow or Journey query, built FROM the scope
 * above so the query cannot drift from the rule.
 *
 * Spread this into a `findFirst`/`findMany`/`count`/`updateMany`/`deleteMany` —
 * never `findUnique`, `update` or `delete`, which take a unique selector and
 * cannot carry a tenant predicate alongside it.
 */
export function flowTenantWhere(tenantId: string): { tenantId: string } | {
  OR: Array<{ tenantId: string | null }>;
} {
  const scope = flowScopeFor({ tenantId });
  return scope.includeUnowned
    ? { OR: [{ tenantId: scope.tenantId }, { tenantId: null }] }
    : { tenantId: scope.tenantId };
}

/**
 * Which tenant a STAFF BUILDER request is for.
 *
 * `enforcedTenantId` is `writeTenantId()` — the enforced scope, or null while
 * enforcement is DORMANT. Resolving the builder from that alone was the defect in
 * the first version of this change: dormant is today, so every builder request
 * collapsed to the founding tenant regardless of the workspace the session was
 * acting as, and a second workspace's owner still listed, opened and saved the
 * founding tenant's flows. The scoping was real and pointed at the wrong tenant.
 *
 * `sessionTenantId` is `getActiveTenantId()` — the session's active workspace,
 * already validated and already dropped when the claim went stale.
 *
 * Falling back to the founding tenant covers a session minted before the claim
 * existed, which is byte-for-byte today's single-tenant behaviour.
 *
 * Pure, so the rule can be executed by a test rather than pattern-matched.
 */
export function decideBuilderTenant(input: {
  enforcedTenantId: string | null;
  sessionTenantId: string | null;
}): string {
  return input.enforcedTenantId ?? input.sessionTenantId ?? DEFAULT_TENANT_ID;
}
