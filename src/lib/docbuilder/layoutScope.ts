/**
 * WHICH WORKSPACE'S LAYOUTS A DOCUMENT MAY PRINT FROM, when what it prints is a
 * bank account to pay into — an invoice, a sales agreement, a customer
 * statement.
 *
 * Those documents carry the workspace's design and its BANKING DETAILS: a
 * published layout, and the text an older one still reads from the old form
 * editor (bank details, payment terms, clauses). So their lookups name the
 * acting workspace in the query itself. The scoped client would add it only
 * while enforcement is on, and enforcement is off by default and in rollback;
 * without the workspace in the query, one business's bank account could be
 * printed on another's documents.
 *
 * A row with NO workspace (`tenantId` NULL) is the hard part. Every layout made
 * before the July backfill (and again before 5 August) carries the founding
 * workspace; the document editor stamps nothing on the ones made since, so they
 * carry NULL. docs/TENANT-ENFORCEMENT-PREREQUISITES.md states the rule this
 * applies: while exactly ONE workspace exists, every NULL row provably belongs
 * to it; once a second exists, no rule can say whose a NULL row is — the same
 * test the signing migration's backfill makes before it stamps anything
 * (`count(*) FROM "Tenant"` must be 1). So:
 *
 *   - the acting workspace's own rows always count, in both modes;
 *   - a row with no workspace counts only while the acting workspace is the
 *     only one there is — which keeps today's single workspace printing exactly
 *     what it prints now;
 *   - with two or more, a row with no workspace is nobody's, and is never read
 *     into anyone's document. Never guessing an owner is the point: a bank
 *     account on the wrong business's invoice is money paid to the wrong
 *     business.
 *
 * Pure (no server imports), so the rule is executed by tests rather than
 * pattern-matched; the server half — who is acting, how many workspaces exist —
 * is `actingLayoutScope()` in ./store.ts.
 */

/**
 * The layout types that are their workspace's OWN — the ones that print its
 * bank account and clauses. Each is opened, listed, changed, defaulted and
 * seeded only inside the acting workspace's scope (getBuilderTemplate and
 * ensureBuilderSeeded in ./store.ts); every other type behaves as it always has.
 */
export const WORKSPACE_LAYOUT_KEYS: ReadonlySet<string> = new Set(["invoice", "agreement"]);

/** The resolved read boundary for one request's layouts. */
export type LayoutScope = {
  /** The acting workspace. */
  tenantId: string;
  /** Whether rows with no workspace count as this workspace's — see the header. */
  includeUnowned: boolean;
};

/**
 * The scope for `tenantId`, given the workspaces that exist. Only the first two
 * ids matter: "exactly one, and it is this one" is the whole question.
 */
export function layoutScopeFor(input: { tenantId: string; workspaceIds: readonly string[] }): LayoutScope {
  const [only, another] = input.workspaceIds;
  return { tenantId: input.tenantId, includeUnowned: only === input.tenantId && another === undefined };
}

/** Whether a row owned by `rowTenantId` is inside `scope` — the rule {@link layoutScopeWhere} puts into SQL. */
export function layoutRowVisible(rowTenantId: string | null | undefined, scope: LayoutScope): boolean {
  if (rowTenantId === null || rowTenantId === undefined) return scope.includeUnowned;
  return rowTenantId === scope.tenantId;
}

/**
 * The `where` fragment for a scope, built from it so a query cannot drift from
 * the rule. For `findMany` / `findFirst` — never a unique lookup, which cannot
 * carry it.
 */
export function layoutScopeWhere(scope: LayoutScope): { tenantId: string } | { OR: Array<{ tenantId: string | null }> } {
  return scope.includeUnowned ? { OR: [{ tenantId: scope.tenantId }, { tenantId: null }] } : { tenantId: scope.tenantId };
}
