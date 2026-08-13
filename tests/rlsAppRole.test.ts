import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { migrationRoleProblem } from "../scripts/apply-migrations.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/** SQL with comments removed — so an assertion cannot be satisfied by prose. */
const sqlBody = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*--.*$/gm, "");

const ROLE_SQL = "prisma/rls/app-role.sql";

/**
 * THE ROLE THAT DOES NOT BYPASS ROW LEVEL SECURITY.
 *
 * 20260727130000_rls_enforce enabled and FORCE'd RLS on 120 tables, and none of
 * it is evaluated, because the application connects as neondb_owner and that
 * role has the BYPASSRLS attribute. FORCE defeats the table OWNER's exemption;
 * it does not defeat the ROLE attribute. Proven read-only on production
 * 2026-08-06: app.current_tenant unset, `SELECT count(*) FROM "Contact"` → 17,
 * where the policy says 0.
 *
 * These tests guard the script that fixes it. They are source assertions rather
 * than database assertions on purpose — `npm run test:rls-restricted` executes
 * this same file against a real Postgres and proves the behaviour; what cannot be
 * proven there is that a future edit has not quietly widened the grant, because a
 * wider grant makes that suite pass more easily, not less.
 */

test("the app role cannot bypass RLS, and the script refuses to continue if it can", () => {
  const sql = sqlBody(ROLE_SQL);

  // THE ROLE MUST BE BORN CORRECT, because it cannot be corrected later.
  //
  // This used to assert a re-asserting `ALTER ROLE crm_app NOSUPERUSER
  // NOBYPASSRLS`, on the reasonable theory that a role which already existed
  // should have its attributes forced. On Neon that statement cannot work: only a
  // SUPERUSER may change BYPASSRLS, `neondb_owner` is not one, Neon exposes none,
  // and Postgres checks the permission even when the change is a NO-OP. So it
  // fails with 42501 whether the role is already correct or not — aborting the
  // file in psql, or (worse) failing one red statement in Neon's SQL editor while
  // the grants around it apply. Verified on production 2026-08-12.
  assert.match(
    sql,
    /CREATE ROLE crm_app LOGIN NOSUPERUSER NOBYPASSRLS/,
    "the only moment these attributes can be set is CREATE ROLE",
  );

  // So the script VERIFIES what it cannot repair, and says exactly what to do.
  assert.match(sql, /SELECT rolsuper, rolbypassrls INTO r FROM pg_roles WHERE rolname = 'crm_app'/);
  assert.match(sql, /IF r\.rolsuper OR r\.rolbypassrls THEN/);
  assert.match(
    sql,
    /RAISE EXCEPTION[\s\S]{0,80}crm_app has rolsuper=/,
    "a role that can bypass RLS must stop the script with a specific error, not a bare 42501",
  );

  // THE BARE ALTER MUST NOT COME BACK. This is the assertion that replaces the
  // old one, inverted: its return would reintroduce the failure above.
  assert.doesNotMatch(
    sql,
    /ALTER ROLE crm_app[^;]*\b(NO)?BYPASSRLS\b/,
    "altering BYPASSRLS needs superuser, which Neon does not have — verify instead",
  );

  // The four attributes a CREATEROLE role IS allowed to change are still forced,
  // so a drifted role can be corrected in place without recreating it.
  assert.match(sql, /ALTER ROLE crm_app NOCREATEDB NOCREATEROLE NOINHERIT/);

  // And it still refuses to finish quietly if either attribute is somehow true.
  assert.match(sql, /RAISE EXCEPTION 'crm_app can bypass RLS/);
});

test("the grant is the four DML verbs and nothing wider", () => {
  const sql = sqlBody(ROLE_SQL);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO crm_app/);

  // ALL PRIVILEGES on a table includes TRUNCATE, REFERENCES and TRIGGER.
  assert.doesNotMatch(sql, /GRANT ALL\b/i, "never GRANT ALL — it is wider than it reads");

  // TRUNCATE removes rows without evaluating a single row-level DELETE policy,
  // so a tenant-scoped role holding it can empty another tenant's table.
  assert.doesNotMatch(sql, /GRANT[^;]*\bTRUNCATE\b/i, "TRUNCATE ignores row-level policies");

  // DDL would let the role drop the very policies that isolate tenants.
  assert.doesNotMatch(sql, /GRANT[^;]*\bCREATE\b[^;]*ON SCHEMA/i, "no DDL in schema public");

  // No statement may CONFER superuser. Scoped to role statements rather than
  // matching the bare word anywhere: `NOSUPERUSER` is the thing we want and does
  // not match `\bSUPERUSER\b`, but the script now also EXPLAINS in a RAISE
  // EXCEPTION message that removing the attribute needs superuser — prose inside
  // a string literal, which sqlBody cannot strip because it is not a comment.
  // The previous form matched that sentence and failed.
  assert.doesNotMatch(
    sql,
    /(ALTER|CREATE)\s+ROLE[^;]*\bSUPERUSER\b/i,
    "the app role must never be granted superuser — it would bypass RLS unconditionally",
  );
});

test("future tables are granted by a RULE, not by a loop that already ran", () => {
  // GRANT ON ALL TABLES iterates the tables that exist at that instant. Without
  // ALTER DEFAULT PRIVILEGES the next migration creates a table the application
  // cannot read, and the deploy that ships it fails with "permission denied for
  // table X" on a path no test covers.
  const sql = sqlBody(ROLE_SQL);
  assert.match(
    sql,
    /ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_app/,
    "must attach to the role migrations run as — default privileges follow the CREATOR",
  );
  assert.match(sql, /ALTER DEFAULT PRIVILEGES IN SCHEMA public\s+GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_app/);
  assert.match(sql, /ALTER DEFAULT PRIVILEGES[\s\S]*?ON SEQUENCES TO crm_app/);
});

test("the script carries no password anyone could read", () => {
  const sql = read(ROLE_SQL);
  // The role is created with a value nobody knows. A placeholder literal in a
  // file in the repository is a login credential in the repository, and a role
  // that does not bypass RLS but has a published password is worse than one that
  // does — it is a foothold that looks like a control.
  assert.match(sql, /md5\(random\(\)::text \|\| clock_timestamp\(\)::text\)/);
  // A literal, on one line — `PASSWORD ' || quote_literal(...)` is a concatenation
  // whose closing quote is on the next line, and is the opposite of a hardcoded one.
  assert.doesNotMatch(sql, /PASSWORD\s+'[^'\n]{3,}'/i, "no literal password in the file");
});

test("the script survives a database that is not Neon", () => {
  const sql = sqlBody(ROLE_SQL);
  // neondb_owner does not exist on a self-hosted install or on the disposable
  // database `npm run test:rls-restricted` builds. Unguarded, ALTER DEFAULT
  // PRIVILEGES FOR ROLE neondb_owner aborts the whole script there — which would
  // mean CI never runs the file that production runs.
  assert.match(sql, /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'neondb_owner'\) THEN/);
  // GRANT CONNECT needs a literal database name, and it differs per environment.
  assert.match(sql, /format\('GRANT CONNECT ON DATABASE %I TO crm_app', current_database\(\)\)/);
  assert.doesNotMatch(sql, /ON DATABASE\s+(neondb|CURRENT_DATABASE)\b/i);
});

test("CI executes the shipped script, not a second copy of what it should do", () => {
  // Two definitions of the role would drift in the direction that makes the test
  // pass: the test grants what the test needs, and production needs the line the
  // test never exercised. ALTER DEFAULT PRIVILEGES was exactly that line.
  const suite = read("scripts/test-rls-restricted.ts");
  assert.match(suite, /path\.join\(process\.cwd\(\), "prisma", "rls", "app-role\.sql"\)/);
  assert.match(suite, /replaceAll\("crm_app", ROLE\)/, "only the role name is substituted");
  // Run the same way a migration is run — which now means the migration runner's
  // OWN dollar-quote-aware splitter, in this process, rather than spawning
  // `npx prisma db execute`. The SQL and its order are identical; the spawn is
  // not, and it is what made this suite unrunnable on Windows (npx cannot be
  // started with execFileSync). app-role.sql is mostly `DO $$ … $$`, so the
  // splitter is load-bearing rather than incidental.
  assert.match(suite, /splitSqlStatements/, "run the same way a migration is run");
  assert.doesNotMatch(
    suite,
    /execFileSync\(\s*"npx"/,
    "no npx spawn — it cannot be execFile'd on Windows, and the splitter makes it unnecessary",
  );
  assert.match(
    suite,
    /a table created after the grants is still readable \(ALTER DEFAULT PRIVILEGES\)/,
    "…and prove the future-table rule, which is the part production would have found",
  );
});

test("the harness drives the application through a role that cannot bypass RLS", () => {
  // THE CANARY. `TimelinePin [READ]` is `prisma.$queryRaw` — no Prisma extension
  // can rewrite raw SQL, so RLS is the only boundary left, and RLS is inert for a
  // BYPASSRLS role. The harness used to connect as the scratch server's bootstrap
  // SUPERUSER, which reproduced production's exemption exactly and made that check
  // unfixable from inside this repository. These assertions are what stop it
  // quietly going back.
  const role = read("scripts/harness/restrictedRole.ts");
  // `\s` already matches newlines; no dotAll flag, which this tsconfig's target
  // does not allow (TS1501).
  assert.match(role, /"prisma",\s*"rls",\s*"app-role\.sql"/, "runs the SHIPPED role script");
  assert.match(role, /replaceAll\("crm_app", HARNESS_APP_ROLE\)/, "only the role name is substituted");
  assert.match(
    role,
    /rolsuper \|\| attrs\.rolbypassrls/,
    "refuses to proceed with a role that can step over a policy",
  );

  const harness = read("scripts/test-tenant-isolation.ts");
  // The two urls, and which is which. Migrations keep the owner exactly as
  // production keeps DATABASE_URL_UNPOOLED on neondb_owner.
  assert.match(harness, /process\.env\.DATABASE_URL = appUrl/);
  assert.match(harness, /process\.env\.DATABASE_URL_UNPOOLED = db\.url/);
  // The four-condition disposability guard must still be applied to the url the
  // application will actually dial, and BEFORE DATABASE_URL is repointed — after
  // it, condition 4 compares the url with itself and cannot fail.
  const guard = harness.indexOf("assertDisposable(appUrl");
  const assign = harness.indexOf("process.env.DATABASE_URL = appUrl");
  assert.ok(guard > 0, "the restricted url goes through assertDisposable");
  assert.ok(guard < assign, "…while DATABASE_URL is still ambient, or condition 4 means nothing");
  // The role is created AFTER the migrations: GRANT ON ALL TABLES is a loop over
  // what exists, so a role granted against an empty schema is granted nothing.
  assert.ok(
    harness.indexOf("migrateHarnessDatabase(db.url") < harness.indexOf("createRestrictedRole(db.url"),
    "the role is created after the migrations, or GRANT ON ALL TABLES covers nothing",
  );
});

test("the allowlist is empty, and the machinery that keeps it honest is not", () => {
  // The list reached zero when the canary flipped. What must NOT follow is the
  // ratchet being deleted as no-longer-needed — it is what stops the NEXT
  // isolation failure arriving as a check that quietly went red.
  const code = read("scripts/harness/acknowledged.ts");
  assert.match(code, /export function unacknowledgedFailures/);
  assert.match(code, /export function staleAcknowledgements/);
  assert.match(code, /export function activeAcknowledgements/);
  const runner = read("scripts/test-tenant-isolation.ts");
  assert.match(runner, /unacknowledged\.length \|\| stale\.length/, "both still fail the build");
});

test("the audit script only reads", () => {
  const code = read("scripts/check-rls-role.ts");
  // It runs against production. Everything it does must be a SELECT — the one
  // apparent exception is set_config(), which is a function call in a SELECT and
  // is transaction-local (TRUE), not a write.
  // Asserted on the LEADING KEYWORD of each statement rather than by scanning for
  // write verbs anywhere in it: the grant audit legitimately contains the strings
  // 'INSERT', 'UPDATE' and 'DELETE' as the privilege names it checks for, and a
  // keyword-anywhere test would either fail on that or have to be weakened until
  // it stopped meaning anything.
  const statements = [
    ...code.matchAll(/\$(?:queryRaw|executeRaw)(?:Unsafe)?(?:<[^>]*>)?`([\s\S]*?)`/g),
  ].map((m) => m[1].trim());
  assert.ok(statements.length >= 6, `expected the audit's raw statements, found ${statements.length}`);
  for (const stmt of statements) {
    assert.match(
      stmt,
      /^SELECT\b/i,
      `every statement in check-rls-role must begin with SELECT — found: ${stmt.slice(0, 70)}`,
    );
  }
  assert.match(code, /set_config\('app\.bypass_rls', 'on', TRUE\)/, "transaction-local, never session-wide");
});

test("the migration runner refuses to migrate as a role that cannot create tables", () => {
  // buildChildEnv falls back to DATABASE_URL when DATABASE_URL_UNPOOLED is unset.
  // Once DATABASE_URL is the restricted role, that fallback runs migrations as a
  // role with no DDL — failing part-way through a migration.sql rather than
  // before touching anything.
  assert.equal(migrationRoleProblem({ role: "neondb_owner", canCreate: true, unpooledConfigured: true }), null);

  const unset = migrationRoleProblem({ role: "crm_app", canCreate: false, unpooledConfigured: false });
  assert.match(unset ?? "", /MIGRATIONS REFUSED/);
  assert.match(unset ?? "", /DATABASE_URL_UNPOOLED is NOT set/, "name the variable that is missing");
  assert.match(unset ?? "", /Nothing has been applied/);

  const wrong = migrationRoleProblem({ role: "crm_app", canCreate: false, unpooledConfigured: true });
  assert.match(wrong ?? "", /DATABASE_URL_UNPOOLED is set but resolves to "crm_app"/, "a different mistake, a different fix");
});

test("the refusal happens before the lock and before any DDL", () => {
  const code = read("scripts/apply-migrations.mjs");
  // The CALL, not the definition — `migrationRoleProblem({` alone matches the
  // exported function's own parameter list, which sits above everything here and
  // would make these comparisons pass no matter where the guard actually runs.
  const guardAt = code.indexOf("const problem = migrationRoleProblem({");
  // The lock CALL, not any mention of it. `pg_advisory_lock(` alone also matches
  // prose in a doc comment further up the file — which is above the guard, so the
  // assertion below inverts and fails for a reason that has nothing to do with
  // ordering. The same trap as the applyOne anchor below, found the same way.
  const lockAt = code.indexOf("SELECT pg_advisory_lock(");
  // The CALL, and `await` is what distinguishes it from the DEFINITION. Dropping
  // the closing paren to survive a new argument made this match the definition
  // instead — which sits ABOVE the guard, so the assertion below inverted and
  // failed loudly. Exactly the trap this comment block was written about.
  const applyAt = code.indexOf("await applyOne(name, childEnv");
  assert.ok(guardAt !== -1 && lockAt !== -1 && applyAt !== -1);
  assert.ok(guardAt < lockAt, "a refused run must not queue behind a real deploy");
  assert.ok(guardAt < applyAt, "…and must not have applied anything");
});

test("--check stays usable as either role", () => {
  // The read-only drift probe is safe from any role and is used as a standalone
  // diagnostic; gating it behind a DDL check would make it useless in exactly
  // the situation it is needed.
  const code = read("scripts/apply-migrations.mjs");
  const checkAt = code.indexOf("if (CHECK_ONLY) {");
  const guardAt = code.indexOf("const problem = migrationRoleProblem({");
  assert.ok(checkAt !== -1 && guardAt !== -1);
  assert.ok(checkAt < guardAt, "--check must return before the DDL guard");
});
