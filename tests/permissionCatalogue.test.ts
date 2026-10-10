import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A permission the app CHECKS has to be one a role can HOLD.
 *
 * There are two lists. `PERMISSIONS` in src/lib/permissions.ts is what the code
 * may ask for; the "Permission" table is what Settings → Access offers to tick,
 * and RolePermission.permissionKey references it, so a key missing from the
 * table can be granted to nobody. Owners skip the check, so the gap is invisible
 * to the person most likely to be testing.
 *
 * Seven keys sat in that gap, two of them `signing.view` and `signing.manage`:
 * for three months nobody but an owner could open Signatures. Nothing failed —
 * the check simply said no to everyone it was ever asked about.
 *
 * Source-scanning, like authorizationSourceReview.test.ts: permissions.ts reaches
 * the database and cannot be imported here.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** The keys the code may ask for. */
function cataloguedKeys(): string[] {
  const source = shipped("src/lib/permissions.ts");
  const start = source.indexOf("export const PERMISSIONS = [");
  assert.notEqual(start, -1, "PERMISSIONS not found — was it renamed?");
  return [...source.slice(start, source.indexOf("] as const", start)).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const migrationsDir = path.join(root, "prisma", "migrations");
const migrationSql = (name: string) => readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8");

/** Every key some migration inserts into "Permission". */
function grantableKeys(): Set<string> {
  const keys = new Set<string>();
  for (const name of readdirSync(migrationsDir)) {
    if (!existsSync(path.join(migrationsDir, name, "migration.sql"))) continue;
    for (const insert of migrationSql(name).matchAll(/INSERT INTO "Permission"[\s\S]*?;/g)) {
      for (const row of insert[0].matchAll(/\(\s*'([a-z_]+\.[a-z_]+)'\s*,/g)) keys.add(row[1]);
    }
  }
  return keys;
}

/**
 * Declared, and read by no guard anywhere in src/ — so there is nothing for a
 * tick-box to switch on. Listing a key here is a claim that it is dead; the
 * second test below fails the moment that stops being true.
 */
const DECLARED_BUT_UNUSED = ["campaigns.test_send"];

test("every permission the code can ask for is one a role can be given", () => {
  const grantable = grantableKeys();
  const missing = cataloguedKeys().filter((key) => !grantable.has(key) && !DECLARED_BUT_UNUSED.includes(key));
  assert.deepEqual(
    missing,
    [],
    `no migration inserts ${missing.join(", ")} into "Permission", so no role can hold ${missing.length === 1 ? "it" : "them"} ` +
      "and only owners pass the check — add the row in a migration",
  );
});

test("a key excused as unused really is read by no guard", () => {
  const sources = walk(path.join(root, "src"))
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith(path.join("lib", "permissions.ts")))
    .map((file) => readFileSync(file, "utf8"));
  for (const key of DECLARED_BUT_UNUSED) {
    assert.ok(cataloguedKeys().includes(key), `${key} is no longer declared — drop it from the excuse list`);
    assert.ok(
      !sources.some((source) => source.includes(`"${key}"`)),
      `${key} is checked somewhere now, so it has to be grantable — add it to "Permission" and remove it from the excuse list`,
    );
  }
});

const GRANT = "20261010090000_signing_permissions_grantable";

test("Signatures goes to the roles that could already send a document for signature, and to nobody else", () => {
  const sql = migrationSql(GRANT);
  const statements = sql.replace(/^\s*--.*$/gm, "").split(";").map((part) => part.trim());
  const grants = statements.filter((part) => part.startsWith('INSERT INTO "RolePermission"'));
  assert.equal(grants.length, 1, "one grant, so there is one rule to read");
  const grant = grants[0];

  // WHAT is granted: the two Signatures keys only. The other keys this migration
  // makes grantable are the owner's to hand out.
  assert.deepEqual(
    [...grant.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]).sort(),
    ["jobcards.manage", "quotes.change_status", "signing.manage", "signing.view"],
  );
  assert.match(grant, /VALUES \('signing\.view'\), \('signing\.manage'\)/);

  // TO WHOM: a role that already holds the permission recordSigning.ts asks for
  // before it will start a signature on that kind of record.
  assert.match(grant, /held\."permissionKey" IN \('quotes\.change_status', 'jobcards\.manage'\)/);
  const starter = shipped("src/app/actions/recordSigning.ts");
  assert.match(starter, /requireQuoteAccess\(id, "quotes\.change_status"\)/);
  assert.match(starter, /requireJobCardAccess\(id, "jobcards\.manage"\)/);

  // IN WHOSE WORKSPACE: the role's own — never a literal, never NULL by default.
  assert.match(grant, /SELECT r\."id", granted\."permissionKey", r\."tenantId"\s+FROM "Role" r/);
  assert.match(grant, /ON CONFLICT DO NOTHING$/);

  // Role and RolePermission FORCE row-level security: without the escape the
  // SELECT sees nothing and the migration "succeeds" having granted nothing.
  assert.ok(
    sql.indexOf("SET app.bypass_rls = 'on'") < sql.indexOf('INSERT INTO "RolePermission"') &&
      sql.indexOf('INSERT INTO "RolePermission"') < sql.indexOf("RESET app.bypass_rls"),
    "the grant must run inside the bypass",
  );
});

test("designing an approval workflow is the owner's, not everyone's who can send a document", () => {
  // Signatures is being handed to sales and workshop roles. A workflow decides
  // whose approval a document needs before the customer may sign, and its
  // actions asked only for `signing.manage` — so the same grant would have let a
  // salesperson delete the approval step their own quote had to pass.
  const actions = shipped("src/app/actions/signflow.ts");
  const exported = [...actions.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(exported.sort(), ["createSignWorkflow", "deleteSignWorkflow", "renameSignWorkflow", "saveSignWorkflow"]);
  for (const name of exported) {
    const start = actions.indexOf(`export async function ${name}(`);
    const end = actions.indexOf("\nexport ", start + 1);
    const body = end === -1 ? actions.slice(start) : actions.slice(start, end);
    assert.match(body, /await requireTenantOwner\(\)/, `${name} must be owner-only`);
  }
  assert.doesNotMatch(actions, /requirePermission|requireAnyPermission/, "no workflow action may fall back to a grantable permission");

  // …the same guard as the two screens that call them.
  for (const page of ["src/app/(app)/settings/signing-workflows/page.tsx", "src/app/(app)/signing-workflows/[id]/page.tsx"]) {
    assert.match(shipped(page), /await requireTenantOwner\(\)/, `${page} is owner-only`);
  }
});

test("being the owner is not the same as it being your workflow: every lookup by id names the workspace", () => {
  // The guard above says who is asking. The id in the request says nothing about
  // whose row it names, and the scoped client adds the workspace only while
  // tenant enforcement is on — so by id alone, one workspace's owner could save,
  // rename and delete another's workflow. scripts/test-signflow-workspace.ts
  // drives that against a real database with enforcement off; this pins the shape.
  const actions = shipped("src/app/actions/signflow.ts");
  // `update`, `delete` and `findUnique` take a unique selector, which cannot
  // carry a workspace beside the id.
  assert.doesNotMatch(actions, /signWorkflow\.(update|delete|findUnique|findUniqueOrThrow)\(/);
  for (const name of ["saveSignWorkflow", "deleteSignWorkflow", "renameSignWorkflow"]) {
    const start = actions.indexOf(`export async function ${name}(`);
    const end = actions.indexOf("\nexport ", start + 1);
    const body = end === -1 ? actions.slice(start) : actions.slice(start, end);
    assert.match(body, /ownedWorkflowWhere\(id\)/, `${name} looks the workflow up as this workspace's`);
    assert.match(body, /signWorkflow\.updateMany\(/, `${name} writes with the workspace in the where`);
    assert.match(body, /\.count [!=]== 1/, `${name} checks it changed exactly one row`);
  }
  assert.match(actions, /signWorkflow\.create\(\{\s*data: \{ tenantId: await actingTenantId\(\),/, "a new workflow is stamped with its workspace");

  const owned = shipped("src/lib/signflow/owned.ts");
  assert.match(owned, /return \{ id, tenantId: await actingTenantId\(\), deletedAt: null \};/);
  assert.match(owned, /signWorkflow\.findFirst\(\{ where: await ownedWorkflowWhere\(id\) \}\)/);

  // The editor opens a workflow through that one function and nothing else.
  const editor = shipped("src/app/(app)/signing-workflows/[id]/page.tsx");
  assert.match(editor, /ownedSignWorkflow\(id\)/);
  assert.doesNotMatch(editor, /signWorkflow\./);
});
