import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * The document scope was consolidated onto one implementation — and the rule it
 * consolidated onto was not tenant-safe.
 *
 * getAccessibleDocumentIds queries through basePrisma, which BYPASSES the RLS
 * extension. It carried no tenant predicate, so whenever a linked-record scope
 * came back unrestricted the `{ contactId: { not: null } }` arm selected
 * contact-linked documents in every tenant. Worse, canAccessDocument answered
 * `ids === null || ids.includes(id)` — so a documents.view_all holder got
 * `true` for ANY id, including one they had merely guessed.
 *
 * Read surfaces mostly re-queried through the scoped client and were saved by
 * RLS. deleteDocument is the one that was not: it writes through the trash
 * helper on basePrisma, so a documents.manage holder could soft-delete another
 * tenant's document by id.
 *
 * These are source guards. A two-tenant behavioural test needs a live database
 * with RLS configured, which this suite does not have — see the PR for what is
 * still owed.
 */

test("the document scope query names its tenant", () => {
  const code = shipped("src/lib/permissions.ts");
  const start = code.indexOf("export async function getAccessibleDocumentIds(");
  assert.notEqual(start, -1, "getAccessibleDocumentIds is gone — was it renamed?");
  const body = code.slice(start, code.indexOf("\nfunction documentTenantWhere", start));
  assert.ok(body.length > 0, "the slice ran backwards");
  assert.match(body, /basePrisma\.document\.findMany/, "still the basePrisma query this guards");
  assert.match(body, /documentTenantWhere\(\)/, "a basePrisma query must carry an explicit tenant predicate");
  assert.match(shipped("src/lib/permissions.ts"), /activeTenantPredicate\("document scope"\)/);
});

test("access to ONE document is decided by resolving that document", () => {
  // `ids === null` means "unrestricted within my tenant", never "unrestricted".
  // Answering from the list alone turned the first into the second.
  const code = shipped("src/lib/permissions.ts");
  const start = code.indexOf("export async function canAccessDocument(");
  const body = code.slice(start, code.indexOf("\nexport async function requireDocumentReadAccess", start));
  assert.match(body, /basePrisma\.document\.findFirst/, "the document itself must be resolved");
  assert.match(body, /documentTenantWhere\(\)/, "…within the active tenant");
  assert.match(body, /if \(!document\) return false;/, "…and a miss is a refusal");
  // The unrestricted short-circuit may remain, but only AFTER the tenant check.
  const tenantCheck = body.indexOf("documentTenantWhere()");
  const shortCircuit = body.indexOf("ids === null");
  assert.ok(
    tenantCheck !== -1 && tenantCheck < shortCircuit,
    `the tenant check must precede the unrestricted short-circuit (${tenantCheck} vs ${shortCircuit})`,
  );
});

test("EVERY soft delete and restore is tenant-scoped, not just documents", () => {
  // Documents were the reported case; contacts, leads, vehicles, products and
  // library documents had the identical shape — a canAccess*() that returns
  // true for any id once the user holds `view_all`, then an unrestricted
  // basePrisma write. An OPTIONAL tenant parameter would have left five of the
  // six callers exactly as they were, so the helper applies it itself and no
  // caller can omit it.
  const trash = shipped("src/lib/trash.ts");
  assert.doesNotMatch(trash, /opts\?:/, "an optional tenant is one a caller can forget");
  assert.match(trash, /function activeTenantWhere\(\)/);
  assert.match(trash, /activeTenantPredicate\(/);

  for (const fn of ["softDeleteRecord", "restoreRecord"]) {
    const start = trash.indexOf(`export async function ${fn}(`);
    assert.notEqual(start, -1, `${fn} is gone — was it renamed?`);
    const body = trash.slice(start, trash.indexOf("\n}", start));
    assert.match(body, /updateMany\(/, `${fn} must write conditionally, so a foreign id matches no rows`);
    assert.match(body, /\.\.\.activeTenantWhere\(\)/, `${fn} must carry the tenant predicate`);
    assert.match(body, /return null;/, `${fn} must report a miss rather than pretend`);
  }
});

test("the Trash page reads within the tenant too", () => {
  // The WRITE side was scoped first, which blocked restoring another tenant's
  // row — but the page still LISTED them. requireOwner() answers "is this
  // person an owner", never "whose data may they see", so an owner of one
  // tenant read every other tenant's deleted contacts, leads, quotes,
  // documents and vehicles: names, addresses, phone numbers, prices. Blocking
  // the restore while still rendering the PII is the wrong half to fix.
  const page = shipped("src/app/(app)/trash/page.tsx");
  assert.match(page, /basePrisma\./, "still the basePrisma page this guards");
  assert.match(page, /\.\.\.activeTenantPredicate\("Trash page"\)/, "the shared predicate must carry the tenant");

  // Every query must go through that one predicate — a `where:` built inline
  // would silently opt out of it.
  const wheres = page.match(/where: [^,\n]+/g) ?? [];
  for (const where of wheres) {
    assert.match(where, /notNull/, `a trash query builds its own where clause: ${where}`);
  }
});

test("under enforcement, a scopeless request is refused rather than unscoped", async () => {
  // THE OWNER ESCAPE HATCH. Under enforcement establishStaffTenantScope
  // deliberately lets a GLOBAL OWNER continue with NO scope when tenant
  // resolution fails, so the platform console still works. The (app) layout
  // redirects that owner — but server actions execute independently of any
  // layout and gate only on requireOwner()/requirePermission().
  //
  // So "no scope" cannot simply mean "no predicate": under enforcement it would
  // hand that owner every tenant's documents, and let them soft-delete or
  // restore another tenant's records by id. Off/monitor still means no
  // predicate, because nothing has established a tenant to filter on.
  const { activeTenantPredicate } = await import("../src/lib/tenantPredicate");
  const { __setTenantEnforcingForTests } = await import("../src/lib/tenantEnforcement");
  const { TenantScopeError } = await import("../src/lib/tenantGuard");

  try {
    __setTenantEnforcingForTests(false);
    assert.deepEqual(activeTenantPredicate("test"), {}, "off/monitor with no scope adds no predicate");

    __setTenantEnforcingForTests(true);
    assert.throws(
      () => activeTenantPredicate("test"),
      TenantScopeError,
      "enforce with no scope must refuse, not run unscoped",
    );
  } finally {
    __setTenantEnforcingForTests(null);
  }
});

test("all three call sites share the one predicate", () => {
  // Three separate copies is how one of them ends up with a different rule.
  for (const rel of [
    "src/lib/trash.ts",
    "src/lib/permissions.ts",
    "src/app/(app)/trash/page.tsx",
  ]) {
    assert.match(
      shipped(rel),
      /activeTenantPredicate\(/,
      `${rel} must resolve the tenant through the shared predicate`,
    );
  }
});

test("a missing scope is not treated as the untenanted tenant", () => {
  // THE REGRESSION THIS EXISTS FOR. `currentTenantScope()?.tenantId ?? null`
  // reads as harmless and breaks the app in its DEFAULT mode:
  // establishStaffTenantScope enters NO scope at all unless
  // TENANT_ENFORCEMENT=enforce, and off/monitor are the documented default and
  // rollback modes. So the predicate became `tenantId: null` — the legacy
  // untenanted value — and every migrated record, which carries a real tenant
  // id, stopped matching. Document reads returned nothing, soft deletes matched
  // no rows and became silent no-ops, and the Trash page rendered empty.
  //
  // No scope means "we were never told which tenant", which is not a filter.
  // Scoped to the helpers this PR added. permissions.ts also has a PRE-EXISTING
  // `?? null` in getUserPermissions' raw SQL, and that one is correct: it feeds
  // `IS NOT DISTINCT FROM`, which matches NULL to NULL, and the whole query is
  // already branched on tenantEnforcing(). A file-wide ban would flag it and
  // teach the next reader that the guard cries wolf.
  // The rule lives in ONE place now, so this checks that place. permissions.ts
  // also has a PRE-EXISTING `?? null` in getUserPermissions' raw SQL, and that
  // one is correct: it feeds `IS NOT DISTINCT FROM`, which matches NULL to
  // NULL, and the query is already branched on tenantEnforcing(). A file-wide
  // ban would flag it and teach the next reader that the guard cries wolf.
  const predicate = shipped("src/lib/tenantPredicate.ts");
  assert.doesNotMatch(
    predicate,
    /\?\?\s*null/,
    "'?? null' turns \"no scope\" into \"the untenanted tenant\" and matches nothing once records are migrated",
  );
  assert.match(predicate, /if \(scope\) return \{ tenantId: scope\.tenantId \}/, "a real scope filters on it");
  assert.match(predicate, /if \(tenantEnforcing\(\)\)/, "…and enforcement decides what a MISSING scope means");
  assert.match(predicate, /return \{\};/, "off\\/monitor adds no predicate");
});

test("no caller announces a delete or restore that did not happen", () => {
  // Every one of these dereferenced the returned row immediately. With the
  // write now able to match nothing, logging first would audit a phantom
  // deletion and then crash reading a name off null.
  for (const [rel, symbol] of [
    ["src/app/actions/documents.ts", "doc"],
    ["src/app/actions/contacts.ts", "contact"],
    ["src/app/actions/leads.ts", "lead"],
    ["src/app/actions/library.ts", "document"],
    ["src/app/actions/products.ts", "product"],
    ["src/app/actions/vehicles.ts", "vehicle"],
    ["src/app/actions/trash.ts", "record"],
  ] as const) {
    const code = shipped(rel);
    const write = code.search(/(softDeleteRecord|restoreRecord)\(/);
    assert.notEqual(write, -1, `${rel} no longer soft-deletes — has it moved?`);
    const after = code.slice(write);
    // Name-agnostic on purpose. The invariant is "check the miss BEFORE
    // auditing", not what the variable is called — and holding the delete and
    // its audit in one transaction meant naming the row inside the callback
    // separately from the result outside it. Pinning the identifier made a
    // structural improvement look like a regression.
    const miss = after.search(new RegExp(`if \\(!(?:${symbol}|\\w+)\\)`));
    const audit = after.search(/logAudit(Strict)?\(\{/);
    assert.ok(miss !== -1, `${rel} must check for a miss before using the row`);
    assert.ok(miss < audit, `${rel} must check the miss BEFORE auditing (${miss} vs ${audit})`);
  }
});

test("a deletion that did not happen is not audited", () => {
  // The audit entry named doc.fileName off the returned row. With the write now
  // able to match nothing, logging before the miss check would record a
  // deletion that never occurred — and crash reading fileName off null.
  const action = shipped("src/app/actions/documents.ts");
  const start = action.indexOf("export async function deleteDocument(");
  const body = action.slice(start, action.indexOf("\nexport async function", start + 1));
  const miss = body.indexOf("if (!doc)");
  const audit = body.indexOf("logAudit({");
  assert.ok(miss !== -1 && miss < audit, `the miss check must precede the audit (${miss} vs ${audit})`);
});
