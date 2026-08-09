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
    /where: \{ \.\.\.activeTenantPredicate\(/,
    "a bypass-client read of tenant-owned data must carry an explicit tenant predicate",
  );
});

test("review sync stamps the owning tenant and dedupes within it", () => {
  const sync = src("src/lib/googleReviews.ts");
  // A NULL-tenant review is invisible the day RLS is switched on.
  assert.match(sync, /const tenantId = writeTenantId\(\) \?\? DEFAULT_TENANT_ID;/);
  assert.doesNotMatch(
    sync,
    /const tenantId = currentTenantScope\(\)\?\.tenantId \?\? null;/,
    "the sync must not write a tenantless review",
  );
  // The dedupe must not reach across tenants.
  assert.doesNotMatch(
    sync,
    /googleReview\.findUnique\(\{ where: \{ externalKey \} \}\)/,
    "a global externalKey lookup lets one tenant suppress another's review",
  );
  assert.match(sync, /where: \{ externalKey, \.\.\.activeTenantPredicate\(/);
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
