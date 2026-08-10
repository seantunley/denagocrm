import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * Google reviews are tenant-owned data reached through the BYPASS client, so the
 * predicate the RLS extension would have added has to be written by hand — in
 * both directions:
 *
 *  - the Inbox read listed every tenant's reviews;
 *  - the sync deduped on a globally-unique externalKey, which is a hash of author
 *    and publish time. Two tenants watching the same Google Place derive the SAME
 *    key, so whoever synced first suppressed the other's copy.
 *
 * Scoping the dedupe read without scoping the constraint would have converted
 * that silent suppression into a unique-violation crash, which is why the key
 * moves to (tenantId, externalKey) here rather than in a later change.
 */

test("the Inbox lists only the active tenant's Google reviews", () => {
  const page = src("src/app/(app)/inbox/page.tsx");
  const call = page.slice(page.indexOf("basePrisma.googleReview.findMany"));
  assert.match(
    call.slice(0, 400),
    /where: \{ tenantId: workspaceTenantId, \.\.\.activeTenantPredicate\(/,
    "a bypass-client read of tenant-owned data must name a concrete tenant AND keep the enforced predicate",
  );
});

/**
 * THIS TEST USED TO PIN BOTH DEFECTS IN PLACE.
 *
 * It required `writeTenantId() ?? DEFAULT_TENANT_ID` and
 * `where: { externalKey, ...activeTenantPredicate(...) }` — the two shapes that
 * made the sync wrong in the mode it ships in. writeTenantId returns null while
 * enforcement is dormant, so every review was filed under the founding tenant
 * regardless of whose slice fetched it, with whose Places credentials. And the
 * predicate returns `{}` while dormant, so the dedupe was global and whoever
 * synced a shared Place first suppressed everyone else's copy.
 *
 * What it can check is the SHAPE. That the shape produces the right rows for two
 * real tenants is proved against a database in
 * scripts/test-google-review-tenant-isolation.ts, which CI runs in the
 * integration lane — and which fails 5 of 7 if either defect is reintroduced.
 */
test("review sync resolves its tenant the same way its credentials do", () => {
  const sync = src("src/lib/googleReviews.ts");

  // The slice already knows which tenant it is: the credential lookup reads it
  // from the ambient scope. Reading the row's owner from anywhere else is how a
  // review fetched with tenant B's key came to be filed under tenant A.
  assert.match(sync, /const tenantId = credentialTenantId \?\? DEFAULT_TENANT_ID;/);
  assert.doesNotMatch(
    sync,
    /const tenantId = writeTenantId\(\)/,
    "writeTenantId is null while enforcement is dormant, which is every day until it is switched on",
  );
  assert.doesNotMatch(sync, /const tenantId = currentTenantScope\(\)\?\.tenantId \?\? null;/, "a tenantless review is invisible the day RLS is switched on");
});

test("the sync dedupe names the tenant instead of asking whether enforcement is on", () => {
  const sync = src("src/lib/googleReviews.ts");
  // The composite unique key is the same fact stated in the database, so the
  // lookup uses it directly and cannot drift from it.
  assert.match(
    sync,
    /findUnique\(\{\s*where: \{ tenantId_externalKey: \{ tenantId: input\.tenantId, externalKey: input\.externalKey \} \}/,
  );
  assert.doesNotMatch(
    sync,
    /activeTenantPredicate\(/,
    "that predicate is {} while dormant, which makes the dedupe global",
  );
  assert.doesNotMatch(
    sync,
    /googleReview\.findUnique\(\{ where: \{ externalKey \} \}\)/,
    "a global externalKey lookup lets one tenant suppress another's review",
  );
  // The constraint is the real fence; the read is an optimisation, so a race
  // between two runs of the same tenant's sync must not throw.
  assert.match(sync, /error\.code === "P2002"/);
});

test("the review identity constraint is scoped to the tenant that reads it", () => {
  const schema = src("prisma/schema.prisma");
  const model = schema.slice(schema.indexOf("model GoogleReview {"), schema.indexOf("\n}", schema.indexOf("model GoogleReview {")));
  assert.match(model, /@@unique\(\[tenantId, externalKey\]\)/);
  assert.doesNotMatch(model, /externalKey String\s+@unique/, "a global key cannot describe per-tenant identity");

  const migration = src("prisma/migrations/20260809210000_google_review_tenant_scope/migration.sql");
  // Backfill first, or the new index can reject rows that already exist.
  const backfill = migration.indexOf('UPDATE "GoogleReview"');
  const create = migration.indexOf("CREATE UNIQUE INDEX");
  assert.ok(backfill >= 0 && create > backfill, "NULL tenants must be backfilled before the index is created");
  assert.match(migration, /DROP INDEX IF EXISTS "GoogleReview_externalKey_key"/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "GoogleReview_tenantId_externalKey_key"/);
});

test("two tenants can hold the same review key without colliding", () => {
  // The regression the roadmap asks for, expressed against the constraint that
  // decides it: the same externalKey under two different tenants is now two rows,
  // where the old global unique made it one.
  const schema = src("prisma/schema.prisma");
  const model = schema.slice(schema.indexOf("model GoogleReview {"), schema.indexOf("\n}", schema.indexOf("model GoogleReview {")));
  const unique = model.match(/@@unique\(\[([^\]]+)\]\)/);
  assert.ok(unique, "GoogleReview must declare a composite identity");
  const parts = unique[1].split(",").map((s) => s.trim());
  assert.deepEqual(parts, ["tenantId", "externalKey"], "tenant must lead the review identity");
});

/**
 * THE P0 IS NOT CLOSED BY A PREDICATE THAT RETURNS `{}`.
 *
 * `activeTenantPredicate` yields no filter while enforcement is dormant, which
 * is the right general rule — filtering on a tenant nobody told us about would
 * hide rows written before the column existed. But dormant is the mode this
 * actually ships in, every day until enforcement is switched on, and for all of
 * that time an unscoped bypass read shows every workspace's reviews to every
 * workspace. An unscoped read is not a migration mechanism.
 *
 * The order matters and is the whole argument: the migration backfills every
 * tenantless review onto the founding tenant FIRST, which is what leaves nothing
 * for an explicit filter to hide.
 */
test("the inbox review query names a tenant even while enforcement is dormant", () => {
  const page = src("src/app/(app)/inbox/page.tsx");

  // The session's workspace, resolved the same way in every enforcement mode.
  assert.match(page, /const workspaceTenantId = \(await getActiveTenantId\(\)\) \?\? DEFAULT_TENANT_ID;/);
  assert.match(
    page,
    /where: \{ tenantId: workspaceTenantId, \.\.\.activeTenantPredicate\("inbox Google reviews"\) \}/,
    "the concrete tenant must be in the where clause, not only the enforcement-dependent predicate",
  );

  // activeTenantPredicate is still spread LAST, so under enforcement the
  // established scope wins and the scopeless-owner case still throws rather than
  // silently widening to every tenant.
  const where = page.slice(page.indexOf("basePrisma.googleReview.findMany"));
  const concrete = where.indexOf("tenantId: workspaceTenantId");
  const predicate = where.indexOf("activeTenantPredicate(");
  assert.ok(concrete >= 0 && predicate > concrete, "the enforced predicate must take precedence");
});

test("the backfill that makes an explicit filter safe ships with it", () => {
  const migration = src("prisma/migrations/20260809210000_google_review_tenant_scope/migration.sql");
  // Without this, filtering by tenant would hide every review written before the
  // column existed — which is precisely why the unscoped read was chosen.
  assert.match(
    migration,
    /UPDATE "GoogleReview" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;/,
    "legacy rows must be given an owner before anything filters on one",
  );
});

/**
 * SCOPING THE ROW AND THEN BROADCASTING ITS TEXT REOPENS THE HOLE ONE LINE LATER.
 *
 * `pushRecipientsForCurrentScope` treats dormant enforcement as "global" and
 * returns EVERY PushSubscription in the table. That is a defensible rollout
 * default and it is not a filter — so a notification carrying a customer's words
 * cannot rely on it. The review row is scoped by hand for exactly this period;
 * the push has to be too, or the author and review text still reach every
 * tenant's phones.
 */
test("the review notification is aimed at the tenant that owns the review", () => {
  const sync = src("src/lib/googleReviews.ts");
  assert.match(sync, /"review",\s*\n\s*\{ tenantId \},/, "the push must name the owning tenant");

  const push = src("src/lib/push.ts");
  assert.match(push, /export async function pushRecipientsForTenant\(tenantId: string\)/);
  // Same shape as the enforcing branch, with the tenant named by the caller
  // rather than inferred from a scope that may not exist yet.
  const targeted = push.slice(push.indexOf("export async function pushRecipientsForTenant"), push.indexOf("export async function pushRecipientsForCurrentScope"));
  assert.match(targeted, /WHERE m\."tenantId" = \$\{tenantId\} AND t\."active" = true AND u\."disabledAt" IS NULL/);
  assert.doesNotMatch(targeted, /currentScopeClass|tenantEnforcing/, "it must not ask whether enforcement is on");

  // And the default path is unchanged for callers that genuinely are global.
  assert.match(push, /options\.tenantId\s*\n?\s*\? await pushRecipientsForTenant\(options\.tenantId\)\s*\n?\s*: await pushRecipientsForCurrentScope\(\)/);
});
