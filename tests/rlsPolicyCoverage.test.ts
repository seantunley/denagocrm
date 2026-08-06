import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * EVERY TENANT-SCOPED TABLE IS BEHIND A POLICY.
 *
 * tenantSchemaContract.test.ts already asserts that every Prisma model is either
 * declared global or carries a `tenantId`. That contract stops at the schema and
 * never reaches the migrations, and the gap between the two was real: migration
 * 20260727130000_rls_enforce enabled Row Level Security on the 120 tables that
 * existed when it was written, production reached 150, and RLS is a PER-TABLE
 * setting. Twenty-seven tables had none.
 *
 * Nothing failed, because the application connects as neondb_owner and that role
 * has BYPASSRLS — a table with no policy and a table with a policy behave
 * identically until the day the connection role changes. The gap was found by
 * running scripts/check-rls-role.ts against production, not by any test.
 *
 * So this is the test that would have caught it: a model with a tenantId whose
 * table is not enabled, policied and forced by some migration fails the build.
 *
 * ── What this cannot see ────────────────────────────────────────────────────
 *
 * ORPHAN TABLES. This walks the Prisma schema, so a table that exists in the
 * database but in no prisma/*.prisma file is invisible to it — by definition.
 * That is not hypothetical: five of the seven tables the production audit found
 * unprotected (AutomationApprovalRequest, AutomationOutbox, CampaignEvent,
 * StockTransferRequest, TenantEmailProvider) are exactly that, left behind by
 * renamed and retired features. They carry tenantId columns and real rows, and
 * no test that reads the repository can ever know they are there.
 *
 * They are pinned by name below instead, and the general answer is
 * `npm run check:rls-role`, which asks the database.
 *
 * Also invisible: a policy dropped by hand, or a migration that failed half way.
 * Same answer — this is a contract over the migrations, not a report on the
 * database, and the runbook has you run both.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const prismaDir = join(root, "prisma");
const migrationsDir = join(prismaDir, "migrations");

/**
 * Tenant-scoped tables that deliberately have NO policy. Each needs a reason
 * that survives someone reading it in a year, because the alternative to a
 * justified exclusion is a quietly-widened test.
 */
const NO_POLICY_BY_DESIGN: Record<string, string> = {
  TenantMember:
    "Answers 'which tenant does this user belong to?' on the login path, before any " +
    "tenant scope exists. A tenantId = current_tenant policy makes that circular. It " +
    "would also silently defeat addTenantMembership()'s one-user-one-tenant guard, " +
    "which queries NOT: { tenantId } and would then match nothing. Needs a " +
    "user-keyed policy, which is a different shape and its own change.",
};

// Prisma runs in folder mode, so EVERY prisma/*.prisma file is part of the
// schema. Reading only schema.prisma is how models in the side-files escaped the
// sibling contract test once already.
const schema = readdirSync(prismaDir)
  .filter((f) => f.endsWith(".prisma"))
  .sort()
  .map((f) => readFileSync(join(prismaDir, f), "utf8"))
  .join("\n");

/** Parse `model X { ... }` blocks (Prisma model bodies have no nested braces). */
function parseModels(src: string): Map<string, string> {
  const models = new Map<string, string>();
  const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) models.set(m[1], m[2]);
  return models;
}

/** The TABLE a model maps to — `@@map("…")` wins, otherwise the model name. */
function tableName(model: string, body: string): string {
  return /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? model;
}

const MODELS = parseModels(schema);
const TENANT_TABLES = new Map<string, string>(); // table -> model
for (const [model, body] of MODELS) {
  if (/^\s*tenantId\s+\w/m.test(body)) TENANT_TABLES.set(tableName(model, body), model);
}

/**
 * Replay the migrations IN ORDER and keep the final state per table, so a policy
 * that a later migration drops is not counted as coverage. Cheap, and the
 * alternative — "the string appears somewhere" — would call a dropped policy
 * present, which is the failure mode this test exists to prevent.
 */
type State = { enabled: boolean; forced: boolean; policies: Set<string> };
const state = new Map<string, State>();
const get = (t: string): State => {
  let s = state.get(t);
  if (!s) state.set(t, (s = { enabled: false, forced: false, policies: new Set() }));
  return s;
};

const migrationNames = readdirSync(migrationsDir)
  .filter((n) => existsSync(join(migrationsDir, n, "migration.sql")))
  .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

// ONE pass, in statement order. Matching each kind of statement separately and
// applying the kinds in turn looks equivalent and is not: every table in
// 20260727130000_rls_enforce is written as `DROP POLICY IF EXISTS …` followed by
// `CREATE POLICY …`, so applying all the CREATEs and then all the DROPs deletes
// every policy the migration just created and reports the entire database as
// unprotected. Order is the whole meaning of a replay.
const STATEMENT =
  /ALTER TABLE\s+"([^"]+)"\s+(ENABLE|DISABLE|FORCE|NO FORCE) ROW LEVEL SECURITY|(CREATE|DROP) POLICY\s+(?:IF EXISTS\s+)?"([^"]+)"\s+ON\s+"([^"]+)"|DROP TABLE\s+(?:IF EXISTS\s+)?"([^"]+)"/gi;

for (const name of migrationNames) {
  const sql = readFileSync(join(migrationsDir, name, "migration.sql"), "utf8");
  for (const m of sql.matchAll(STATEMENT)) {
    const [, rlsTable, rlsVerb, polVerb, polName, polTable, droppedTable] = m;
    if (rlsTable) {
      const s = get(rlsTable);
      if (rlsVerb.toUpperCase() === "ENABLE") s.enabled = true;
      else if (rlsVerb.toUpperCase() === "DISABLE") s.enabled = false;
      else if (rlsVerb.toUpperCase() === "FORCE") s.forced = true;
      else s.forced = false;
    } else if (polTable) {
      const s = get(polTable);
      if (polVerb.toUpperCase() === "CREATE") s.policies.add(polName);
      else s.policies.delete(polName);
    } else if (droppedTable) {
      // A dropped table takes its policies with it.
      state.delete(droppedTable);
    }
  }
}

test("the migration replay found a plausible amount of RLS", () => {
  // A broken parser would report zero problems, which is indistinguishable from
  // success. This is the assertion that tells the two apart.
  assert.ok(migrationNames.length > 50, `only ${migrationNames.length} migrations parsed`);
  assert.ok(TENANT_TABLES.size >= 100, `only ${TENANT_TABLES.size} tenant-scoped models parsed`);
  const enabled = [...state.values()].filter((s) => s.enabled).length;
  assert.ok(enabled >= 100, `only ${enabled} tables end up with RLS enabled`);
});

test("every tenant-scoped model has RLS enabled by a migration", () => {
  const missing: string[] = [];
  for (const [table, model] of TENANT_TABLES) {
    if (NO_POLICY_BY_DESIGN[model]) continue;
    if (!get(table).enabled) missing.push(`${model} (table "${table}")`);
  }
  assert.deepEqual(
    missing.sort(),
    [],
    `Tenant-scoped models with NO row level security. Add them to a migration in the shape of ` +
      `20260806180000_rls_enforce_gap, or justify the exclusion in NO_POLICY_BY_DESIGN:\n  ${missing.join("\n  ")}`,
  );
});

test("every tenant-scoped model has an isolation policy", () => {
  // RLS enabled with NO policy denies every row. Under the current owner role
  // that is invisible; under the restricted role it is an outage, and it looks
  // exactly like correct isolation from the outside.
  const missing: string[] = [];
  for (const [table, model] of TENANT_TABLES) {
    if (NO_POLICY_BY_DESIGN[model]) continue;
    if (get(table).policies.size === 0) missing.push(`${model} (table "${table}")`);
  }
  assert.deepEqual(missing.sort(), [], `Tenant-scoped models with RLS but no policy:\n  ${missing.join("\n  ")}`);
});

test("every tenant-scoped model is FORCE'd", () => {
  // Without FORCE, the role that OWNS the table is exempt from its policies —
  // and migrations create every table as the owner.
  const missing: string[] = [];
  for (const [table, model] of TENANT_TABLES) {
    if (NO_POLICY_BY_DESIGN[model]) continue;
    if (!get(table).forced) missing.push(`${model} (table "${table}")`);
  }
  assert.deepEqual(missing.sort(), [], `Tenant-scoped models without FORCE ROW LEVEL SECURITY:\n  ${missing.join("\n  ")}`);
});

test("the gap migration covers exactly what production was missing", () => {
  // The seven tables scripts/check-rls-role.ts found on production, read-only,
  // on 2026-08-06. Pinned so that removing one from the migration fails here
  // rather than at the cutover.
  //
  // This list is load-bearing rather than belt-and-braces: FIVE of the seven are
  // orphans with no Prisma model, so the schema-driven tests above cannot see
  // them at all. Delete a line from this test and that table silently stops
  // being protected with nothing else failing.
  const sql = readFileSync(join(migrationsDir, "20260806180000_rls_enforce_gap", "migration.sql"), "utf8");
  for (const table of [
    "AutomationApprovalRequest",
    "AutomationOutbox",
    "BackupRun",
    "CampaignEvent",
    "ErrorLog",
    "StockTransferRequest",
    "TenantEmailProvider",
  ]) {
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`), `${table} must be enabled`);
    assert.match(sql, new RegExp(`CREATE POLICY "${table}_tenant_isolation"`), `${table} must have a policy`);
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`), `${table} must be forced`);
  }
  // Additive only. This lands while production still connects as the owner, so
  // it must not be able to change a single row on the way past.
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP TABLE|ALTER COLUMN|TRUNCATE)\b/i);

  // EVERY block guarded on the table existing, and no bare ALTER TABLE anywhere.
  //
  // Five of these seven exist in production and in no migration, so a database
  // built from this repository does not have them. The first version of this
  // file said `ALTER TABLE "AutomationApprovalRequest" ENABLE ROW LEVEL SECURITY`
  // unconditionally, and CI failed with P1014 — "the underlying table does not
  // exist" — which was correct. A migration that only works against one
  // particular database is not a migration.
  const uncommented = sql.replace(/^\s*--.*$/gm, "");
  assert.equal(
    (uncommented.match(/^ALTER TABLE/gm) ?? []).length,
    0,
    "no top-level ALTER TABLE — every statement must sit inside an existence check",
  );
  assert.equal(
    (uncommented.match(/IF EXISTS \(SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = '/g) ?? []).length,
    7,
    "one existence guard per table",
  );
  // Dollar-quoting has to balance or the whole script is one syntax error, and
  // an unbalanced DO block is not something a source test can shrug off.
  assert.equal((uncommented.match(/DO \$\$/g) ?? []).length, 7);
  assert.equal((uncommented.match(/END \$\$;/g) ?? []).length, 7);
  assert.equal((uncommented.match(/END IF;/g) ?? []).length, 7);

  // STATIC DDL inside the guard, not EXECUTE'd strings. plpgsql resolves names at
  // execution rather than compile time, so a branch that is not taken may name a
  // table that does not exist — which is exactly the case here. Dynamic SQL would
  // work too, but it needs nested $tag$ quoting to carry the policy's own single
  // quotes, and no migration in this repository has ever used that. Sticking to
  // constructs the runner has already executed is worth more than brevity.
  assert.doesNotMatch(uncommented, /EXECUTE /, "no dynamic SQL");
  assert.doesNotMatch(uncommented, /\$[a-z]+\$/, "no nested dollar-quoting");
});

test("no exclusion is stale, and each one says why", () => {
  for (const [model, reason] of Object.entries(NO_POLICY_BY_DESIGN)) {
    const body = MODELS.get(model);
    assert.ok(body !== undefined, `NO_POLICY_BY_DESIGN names "${model}", which is not a model`);
    assert.ok(
      /^\s*tenantId\s+\w/m.test(body!),
      `NO_POLICY_BY_DESIGN names "${model}", but it has no tenantId — it is not an exclusion from anything`,
    );
    assert.ok(reason.length > 80, `"${model}" needs a real reason, not "${reason}"`);
  }
});

test("the audit script derives scope from the schema, not from a hand-written list", () => {
  // The original version of check-rls-role.ts carried a hardcoded set of
  // "global" tables, and it was WRONG about TenantMember on the first run — it
  // has a tenantId. A list maintained by hand drifts exactly the way the RLS
  // coverage drifted; asking the table whether it has a tenantId column does not.
  const code = readFileSync(join(root, "scripts", "check-rls-role.ts"), "utf8");
  assert.match(code, /attname = 'tenantId'/, "must ask the database which tables are tenant-scoped");
  assert.doesNotMatch(code, /const GLOBAL_TABLES = new Set/, "no hand-maintained global list");
});
