import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
/** Source with comments removed — a rule satisfied by a comment is not satisfied. */
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * The last findings from PAGE-GUARD-AUDIT.md, and the structural rules that keep
 * each one closed.
 *
 * Every one is the same failure: a permission that answers "may this person use
 * this feature" was read as if it answered "may this person have THIS record".
 * They are separate questions and the second was never asked.
 */

/* ── R1 / R2 — the doc-editor render endpoints ────────────────────────── */

const BUILDER_CALLERS = [
  "src/app/actions/doceditor.ts",
  "src/app/api/pdf/doc-editor/[id]/route.ts",
  "src/app/api/doc-editor/[id]/export/route.ts",
] as const;

test("every doc-editor render path asks the same question about the record", () => {
  // `docbuilder.view` is a capability. The record id arrives separately — off a
  // form field or a query string — and the permission says nothing about it. The
  // action grew the record check; the two API routes rendering the same templates
  // from the same ids never did, so a docbuilder.view holder with no quotes
  // permission got any quote as a PDF, or as html/email/doc, by id alone.
  const helper = shipped("src/lib/docbuilder/recordAccess.ts");
  assert.match(helper, /export async function canAccessBuilderRecord\(/);
  assert.match(helper, /canAccessQuote\(/, "quotes are decided by the quote scope");
  assert.match(helper, /canAccessJobCard\(/, "job cards by the job-card scope");

  for (const file of BUILDER_CALLERS) {
    const code = shipped(file);
    assert.match(
      code,
      /canAccessBuilderRecord\(/,
      `${file} renders a bound record without checking access to it`,
    );
    // A second copy of the decision is how the routes drifted from the action in
    // the first place. One function, or the next one drifts too.
    assert.doesNotMatch(
      code,
      /canAccess(Quote|JobCard)\(/,
      `${file} must reach the decision through canAccessBuilderRecord, not its own copy`,
    );
  }
});

test("the record check runs before anything is rendered or returned", () => {
  for (const file of BUILDER_CALLERS.slice(1)) {
    const code = shipped(file);
    const check = code.indexOf("canAccessBuilderRecord(");
    const generate = code.search(/generateDocEditor(Pdf|Export)\(/);
    assert.ok(check !== -1 && generate !== -1, `${file}: expected both a check and a render`);
    assert.ok(check < generate, `${file}: the record is rendered before it is checked`);
  }

  // The export route's `format=json` branch returns the TEMPLATE, not the record,
  // and deliberately ignores the binding — so it sits after the check rather than
  // before it. If it moved above, choosing a format would skip the record check
  // for every other format too.
  const exportRoute = shipped("src/app/api/doc-editor/[id]/export/route.ts");
  assert.ok(
    exportRoute.indexOf("canAccessBuilderRecord(") < exportRoute.indexOf('requested === "json"'),
    "the record check must not be skippable by asking for a different format",
  );
});

test("an inaccessible record and a missing one are indistinguishable", () => {
  // Otherwise these endpoints are an existence oracle: POST an id, read the
  // status code, learn whether that quote exists in someone else's workspace.
  const helper = shipped("src/lib/docbuilder/recordAccess.ts");
  assert.match(helper, /export const RECORD_UNAVAILABLE = /, "one message, defined once");
  for (const file of BUILDER_CALLERS) {
    assert.match(shipped(file), /RECORD_UNAVAILABLE/, `${file} must use the shared refusal`);
  }
  for (const file of BUILDER_CALLERS.slice(1)) {
    assert.match(
      shipped(file),
      /RECORD_UNAVAILABLE, \{ status: 404 \}/,
      `${file}: 403 says "it exists and you may not"; 404 says neither`,
    );
  }
});

/* ── A1 — grantPortalAccess ───────────────────────────────────────────── */

test("a portal grant resolves both ids before it writes one", () => {
  // Both came off the form and went straight into the INSERT. Every "use server"
  // export is a public endpoint, so a forged POST could file a grant pointing at
  // another workspace's contact or fleet — stamped with the caller's tenantId,
  // which makes it a valid grant over a foreign customer once the column is read.
  const code = shipped("src/app/actions/portalAdmin.ts");
  const start = code.indexOf("export async function grantPortalAccess(");
  const end = code.indexOf("export async function revokePortalAccess(");
  assert.ok(start !== -1 && end > start, "grantPortalAccess is gone — was it renamed?");
  const body = code.slice(start, end);

  const insert = body.indexOf("$executeRaw");
  assert.notEqual(insert, -1, "the grant is still written with raw SQL");
  for (const id of ["viewerContactId", "targetId"]) {
    const resolved = body.indexOf(`id: ${id},`);
    assert.ok(resolved !== -1, `${id} is written without ever being resolved`);
    assert.ok(resolved < insert, `${id} is resolved after the grant is already written`);
  }
  assert.match(
    body,
    /activeTenantPredicate\("portal access grant"\)/,
    "an id resolved without a tenant predicate is resolved across every workspace",
  );
  assert.match(
    body,
    /if \(!viewer \|\| !target\) throw new ActionRefusal/,
    "resolving is not checking — a miss must refuse",
  );
});

/* ── P3 — /audit ──────────────────────────────────────────────────────── */

test("every audit read names its tenant, and the actor list is this tenant's staff", () => {
  // basePrisma bypasses the tenant guard by design, so the predicate is written by
  // hand — the same reasoning documented at permissions.ts and settings/page.tsx.
  // AuditEvent is the table holding every actor, entity id and change summary in
  // the workspace, and this page carried no predicate at all while the export
  // route it feeds already did.
  const code = shipped("src/app/(app)/audit/page.tsx");
  const auditReads = [...code.matchAll(/FROM "AuditEvent"/g)];
  assert.ok(auditReads.length >= 3, `expected the AuditEvent reads, found ${auditReads.length}`);

  const clauses = [...code.matchAll(/NOT \$\{enforcing\}::boolean OR "tenantId" IS NOT DISTINCT FROM \$\{activeTenantId\}/g)];
  assert.equal(
    clauses.length,
    auditReads.length,
    `${auditReads.length} AuditEvent reads but ${clauses.length} tenant clauses — one read is unscoped`,
  );

  // The ACTING variant: the background one skips its TenantMember join while
  // enforcement is dormant, so this filter would list every account on the
  // platform in exactly the environments we run.
  assert.match(code, /listActingTenantStaff\(\)/, "the actor filter must list this tenant's staff");
  assert.doesNotMatch(
    code,
    /FROM "User"/,
    'User is a global model with no tenantId — a raw `FROM "User"` lists every account on the platform',
  );
});

test("the audit page scopes exactly the way its own export route does", () => {
  // These two read the same table through the same client for the same person.
  // They drifted once; naming the pairing here is what stops them drifting again.
  const page = shipped("src/app/(app)/audit/page.tsx");
  const exportRoute = shipped("src/app/api/audit/export/route.ts");
  const clause = /AND \(NOT \$\{enforcing\}::boolean OR "tenantId" IS NOT DISTINCT FROM \$\{activeTenantId\}\)/;
  assert.match(exportRoute, clause, "the export route's clause moved — update the page to match");
  assert.match(page, clause, "the page must carry the same clause as the export");
  for (const code of [page, exportRoute]) {
    assert.match(code, /tenantEnforcing\(\)/, "the clause is dormant until enforcement is on");
    assert.match(code, /getActiveTenantId\(\)/);
  }
});

/* ── P4 / P5 / P6 — edit pages under a read-guarded layout ────────────── */

/** Every `[id]/edit/page.tsx` under the app shell, found by walking, not guessing. */
function editPages(dir = "src/app/(app)"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...editPages(rel));
    else if (entry.name === "page.tsx" && dir.endsWith("/edit")) out.push(rel);
  }
  return out;
}

test("an edit form is guarded by the permission that saves it, not the one that reads it", () => {
  // Three of these had no guard at all. Each sat under a `[id]/layout.tsx` whose
  // guard is require*ReadAccess — so a READ grant opened the WRITE form, prefilled
  // with the record. The shipped Next docs say a layout is the wrong place for
  // this outright (01-app/02-guides/authentication.md:1454: this pattern "will not
  // prevent nested route segments and Server Actions from being accessed"), and a
  // layout does not re-render on client navigation either.
  const pages = editPages();
  assert.ok(pages.length >= 4, `expected to find the edit pages, found ${pages.length}`);

  for (const page of pages) {
    const code = shipped(page);
    const guard = code.match(/await require[A-Za-z]+\(([^)]*)\)/);
    assert.ok(guard, `${page} has no guard of its own — it inherits whatever its layout allows`);
    const keys = [...guard[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(keys.length > 0, `${page}: the guard names no permission`);
    for (const key of keys) {
      assert.doesNotMatch(
        key,
        /\.view(_all|_owned)?$/,
        `${page} is guarded by ${key} — a read permission cannot authorise a write form`,
      );
    }
  }
});

test("the edit pages' pickers are scoped to what the caller may see", () => {
  // Each also loaded 500 contacts and every user row to populate its dropdowns.
  for (const page of ["src/app/(app)/leads/[id]/edit/page.tsx", "src/app/(app)/vehicles/[id]/edit/page.tsx"]) {
    assert.match(
      shipped(page),
      /where: accessibleContactIds \? \{ id: \{ in: accessibleContactIds \} \} : \{\}/,
      `${page}: the customer picker is unscoped`,
    );
  }
  for (const page of ["src/app/(app)/leads/[id]/edit/page.tsx", "src/app/(app)/contacts/[id]/edit/page.tsx"]) {
    const code = shipped(page);
    assert.match(code, /listActingTenantStaff\(\)/, `${page}: the staff picker must be this tenant's staff`);
    assert.doesNotMatch(
      code,
      /prisma\.user\.findMany/,
      `${page}: User is global — findMany lists every account on the platform`,
    );
  }
});
