// Unified migration apply — used by CI, preview and production so all three
// behave identically. The migration folders use non-zero-padded numeric
// prefixes, so Prisma's lexical `migrate deploy` mis-orders them on a fresh
// database (e.g. 10_dealer_signature before 4_quotes → "relation Quote does not
// exist"). This applies each pending migration in true NUMERIC order and records
// it with Prisma's own `migrate resolve`, so the _prisma_migrations bookkeeping
// stays fully Prisma-compatible.
//
// It is idempotent: migrations already recorded in _prisma_migrations are
// skipped. On an existing, fully-migrated database (production) it applies and
// records NOTHING — it is a complete no-op. Only fresh / disaster-recovery
// databases actually run migrations here.
//
// SAFETY (why this is more than db-execute + resolve):
//   1. Every child `prisma` command is pinned to the SAME database this runner
//      checked and locked (see childEnv). Historically, `db execute` (the SQL)
//      and `migrate resolve` (the bookkeeping) resolved their connection
//      independently — a migration could get RECORDED as applied on one database
//      while its SQL ran against another (or never ran), leaving a missing column
//      that 500'd login. Pinning removes that split-brain.
//   2. After applying, an integrity check asserts the live database actually
//      contains every table/column the deployed schema requires. If a migration
//      is recorded-but-not-really-applied, the deploy FAILS LOUDLY here instead
//      of shipping code that will 500 on the missing object.
//
// Usage:
//   node scripts/apply-migrations.mjs            apply pending migrations
//   node scripts/apply-migrations.mjs --dry-run  report decisions, change nothing
//   node scripts/apply-migrations.mjs --check    run ONLY the integrity check

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { splitSqlStatements } from "./lib/splitSqlStatements.mjs";

const DRY_RUN = process.argv.includes("--dry-run");
const CHECK_ONLY = process.argv.includes("--check");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "prisma", "migrations");
const schemaPath = join(root, "prisma");
const schemaFile = join(schemaPath, "schema.prisma");

// Arbitrary 32-bit constant. A session advisory lock on this key serialises
// concurrent runs (e.g. two overlapping Vercel deploys) so they cannot apply
// migrations simultaneously.
const MIGRATION_LOCK_KEY = 913472651;

// Runs in CI, on Vercel, and in disaster-recovery — all Linux, where `npx`
// resolves directly. (Not invoked from a local Windows shell, where the npm shim
// is `npx.cmd` and cannot be execFileSync'd without a shell; a shell would in
// turn mangle the `&` in the database URL argument.)
const NPX = "npx";

/** Migration directories with a migration.sql, ordered by their numeric prefix. */
function orderedMigrations() {
  return readdirSync(migrationsDir)
    .filter((name) => /^\d+_/.test(name) && existsSync(join(migrationsDir, name, "migration.sql")))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
}

/**
 * Classify the migration LEDGER against the migrations that actually exist.
 *
 * `assertSchemaObjectsPresent` answers "does the database have the tables and
 * columns the schema needs?" — a different question, and it was the only one
 * being asked. Nothing looked at the bookkeeping itself, so production
 * accumulated 15 records for migrations that no longer exist in the repository
 * and one recorded as rolled back, entirely unnoticed until somebody went
 * looking by hand.
 *
 * Neither is dangerous to THIS runner, which only ever iterates directories it
 * can see. Both matter anyway:
 *
 *   - `prisma migrate deploy` refuses to run at all while a failed or
 *     rolled-back record is present, so the fallback path is quietly unusable;
 *   - a ledger nobody reconciles is how "recorded but never executed" hid last
 *     time, and that one did cause an outage.
 *
 * Pure and exported so the classification is testable without a database.
 */
export function auditMigrationLedger(recorded, onDisk) {
  const known = new Set(onDisk);
  return {
    phantom: recorded
      .filter((row) => !known.has(row.migration_name))
      .map((row) => row.migration_name),
    unfinished: recorded
      .filter((row) => !row.finished_at || row.rolled_back_at)
      .map((row) => row.migration_name),
  };
}

/** Report ledger drift. Never fails the deploy: every record here predates the check. */
async function reportLedgerDrift(prisma) {
  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      'SELECT "migration_name", "finished_at", "rolled_back_at" FROM "_prisma_migrations"',
    );
  } catch {
    return; // brand-new database
  }
  const { phantom, unfinished } = auditMigrationLedger(rows, orderedMigrations());
  if (phantom.length) {
    console.warn(
      `::warning::${phantom.length} migration record(s) have no migration in this repository: ` +
        `${phantom.join(", ")}. Withdrawn or renamed migrations leave these behind.`,
    );
  }
  if (unfinished.length) {
    console.warn(
      `::warning::${unfinished.length} migration record(s) are unfinished or rolled back: ` +
        `${unfinished.join(", ")}. \`prisma migrate deploy\` will refuse to run while these exist.`,
    );
  }
}

async function appliedNames(prisma) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL',
    );
    return new Set(rows.map((r) => r.migration_name));
  } catch {
    // Table absent → brand-new database, nothing applied yet.
    return new Set();
  }
}

function run(cmd, args, env) {
  execFileSync(cmd, args, { cwd: root, stdio: "inherit", env });
}

function capture(cmd, args, env) {
  return execFileSync(cmd, args, { cwd: root, encoding: "utf8", env });
}

/**
 * Classify a `prisma migrate diff` script (DB → deployed schema) into:
 *  - `missing`: CREATE TABLE / ADD COLUMN — tables/columns the DB LACKS that the
 *    deployed code needs. These are deploy-blocking: shipping code against a
 *    missing object 500s (this is the class that caused the login outage).
 *  - `otherDrift`: missing indexes / column-attribute differences — real but
 *    non-blocking; reported as warnings.
 * DROP statements (objects the DB has but the schema doesn't — e.g. tables left
 * by other branches) are intentionally ignored: harmless to the deployed code.
 * Pure + exported so the exact rule is covered by tests and can't silently drift.
 */
export function classifyDiffScript(script) {
  const lines = (script || "").split("\n");
  return {
    missing: lines.filter((l) => /^\s*CREATE TABLE\b/i.test(l) || /\bADD COLUMN\b/i.test(l)),
    otherDrift: lines.filter((l) => /\b(CREATE (UNIQUE )?INDEX|ALTER COLUMN)\b/i.test(l)),
  };
}

/**
 * Pin every child `prisma` invocation to the SAME direct database this runner
 * checks and locks, so apply + record + verify can never drift onto different
 * databases (the root cause of the recorded-but-not-applied outage). Pure +
 * exported so the pinning contract is covered by tests. Returns a NEW env object.
 */
export function buildChildEnv(env) {
  const directUrl = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL;
  return directUrl
    ? { ...env, DATABASE_URL: directUrl, DATABASE_URL_UNPOOLED: directUrl }
    : { ...env };
}

/**
 * REFUSE TO MIGRATE AS A ROLE THAT CANNOT CREATE TABLES.
 *
 * buildChildEnv falls back to DATABASE_URL when DATABASE_URL_UNPOOLED is unset.
 * That fallback is right today, and it becomes a trap the moment DATABASE_URL is
 * repointed at the restricted application role (prisma/rls/app-role.sql), which
 * deliberately has no DDL: the runner would try to migrate as a role that cannot
 * CREATE TABLE, and every deploy would fail somewhere in the middle of a
 * migration rather than before touching anything.
 *
 * `prisma db execute` runs a migration.sql as ONE script — a failure part-way
 * through leaves the statements before it applied and the migration unrecorded.
 * Idempotent migrations survive that, but it is not a state to walk into on
 * purpose when a single privilege check upfront says "stop".
 *
 * Pure and exported: the message is the whole value of this check, so it is
 * asserted in tests rather than left to be discovered during an outage.
 *
 * @param {{ role: string, canCreate: boolean, unpooledConfigured: boolean }} facts
 * @returns {string | null} the refusal message, or null when the role is fine
 */
export function migrationRoleProblem({ role, canCreate, unpooledConfigured }) {
  if (canCreate) return null;
  return (
    `\n✖ MIGRATIONS REFUSED — the role "${role}" cannot create objects in schema public.\n\n` +
    `  Migrations need DDL. The restricted application role does not have it, by design:\n` +
    `  it is the role that does NOT bypass Row Level Security, and giving it DDL would\n` +
    `  let it drop the policies that isolate tenants.\n\n` +
    (unpooledConfigured
      ? `  DATABASE_URL_UNPOOLED is set but resolves to "${role}". Point it at the OWNER\n` +
        `  role (neondb_owner), not the application role.\n`
      : `  DATABASE_URL_UNPOOLED is NOT set, so this runner fell back to DATABASE_URL —\n` +
        `  which is now the application role. Set DATABASE_URL_UNPOOLED to the OWNER\n` +
        `  role's direct connection string.\n`) +
    `\n  See docs/RLS-ROLE-CUTOVER.md. Nothing has been applied.\n`
  );
}

/** Default schema-diff probe: `prisma migrate diff` (DB → deployed schema). */
function defaultRunDiff(childEnv) {
  return capture(
    NPX,
    ["prisma", "migrate", "diff", "--from-url", childEnv.DATABASE_URL, "--to-schema-datamodel", schemaFile, "--script"],
    childEnv,
  );
}

/**
 * The checksum Prisma stores for a migration: SHA-256 of migration.sql, exactly
 * as `migrate resolve` and `migrate deploy` compute it.
 *
 * Verified against production before this was relied on: rows written by Prisma
 * itself carry precisely this digest of the file on disk. Getting it wrong would
 * not fail here — it would make a LATER `prisma migrate` run report the migration
 * as modified, which is a confusing way to find out. Exported so a test can
 * compare it against a real file.
 */
export function migrationChecksum(name) {
  return createHash("sha256")
    .update(readFileSync(join(migrationsDir, name, "migration.sql")))
    .digest("hex");
}

/**
 * Record a migration as applied, from the parent process rather than a second CLI.
 *
 * This replaces a second `npx prisma migrate resolve` child process. That spawn
 * cost about 1.4 seconds of CLI startup, and with 178 migrations the pair of them
 * accounted for 491 of CI's ~900 seconds — almost none of it spent on SQL.
 *
 * It is also safer than the process it replaces, though it is worth being exact
 * about how — an earlier version of this comment overstated it.
 *
 * The SQL still runs in the `npx prisma db execute` CHILD process. Only the ledger
 * write moved here, to the parent's Prisma client. So this is NOT "the same
 * connection that applied the SQL": it is two connections, to a database this
 * process has already checked and locked, one of which it now controls directly.
 *
 * What that buys is real but narrower than "same connection". The header of this
 * file records why the child commands are pinned: `db execute` and
 * `migrate resolve` used to RESOLVE THEIR TARGET independently, so a migration
 * could be recorded against one database while its SQL ran against another,
 * leaving a missing column that 500'd login. One of those two resolutions is now
 * gone — the ledger write cannot land anywhere but the database this runner
 * connected to. The remaining child is still pinned by childEnv, as before.
 *
 * applied_steps_count is 1, matching `migrate deploy`, because the whole file was
 * applied. `migrate resolve` writes 0 — it means "assume this ran", which is not
 * what happened here.
 */
export function isMissingLedgerTable(error) {
  // Prisma wraps the Postgres code rather than exposing it directly. Both signals
  // are checked, and anything else is rethrown: a catch-all here would turn a real
  // database failure into a silent fallback, which is the opposite of the point.
  const meta = error?.meta ?? {};
  return (
    meta.code === "42P01" ||
    /relation "_prisma_migrations" does not exist/i.test(String(error?.message ?? ""))
  );
}

export async function recordApplied(prisma, name, childEnv, runner = run) {
  try {
    await insertLedgerRow(prisma, name);
  } catch (error) {
    if (!isMissingLedgerTable(error)) throw error;
    // A BRAND-NEW DATABASE has no _prisma_migrations table yet — `migrate resolve`
    // is what creates it, which is why the old two-spawn version never hit this.
    // CI found it on the first run against an empty database, which is exactly
    // where it should be found.
    //
    // Prisma creates the table with ITS OWN definition rather than one written out
    // here. Hand-copying that DDL would work until Prisma changed a column type
    // and left this repository quietly holding a table Prisma no longer expects.
    // One extra spawn, once per fresh database.
    runner(NPX, ["prisma", "migrate", "resolve", "--schema", schemaPath, "--applied", name], childEnv);
  }
}

async function insertLedgerRow(prisma, name) {
  await prisma.$executeRaw`
    INSERT INTO "_prisma_migrations"
      ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count")
    VALUES
      (${randomUUID()}, ${migrationChecksum(name)}, now(), ${name}, NULL, NULL, now(), 1)
  `;
}

/**
 * Force a Prisma datasource URL to use ONE pooled connection.
 *
 * THIS IS A CORRECTNESS REQUIREMENT, NOT A TUNING KNOB.
 *
 * Migrations are now executed statement by statement from this process instead
 * of being handed to `prisma db execute` as a whole file. That is what removes
 * the per-migration process spawn — but `db execute` ran the entire file on a
 * single connection, and TEN migrations depend on exactly that. Each opens with
 * `SET app.bypass_rls = 'on'` and resets it many statements later:
 *
 *     20260805230000_signing_trust_platform          80 statements between SET and RESET
 *     20260804120000_reporting_statistics            36
 *     20260805232000_signing_event_ledger            19
 *     20260802120000_retire_automation_rules         17
 *     20260805235000_signing_token_vault             14
 *     …and five more (signing_*, dashboard_config, journey_multiple_triggers)
 *
 * `app.bypass_rls` is a SESSION setting, and it is what lets those migrations
 * write past the row-level security policies. Prisma pools connections, so
 * consecutive statements can otherwise land on different sessions: the SET
 * applies to one connection while the UPDATEs it was protecting run on another,
 * where RLS silently filters them to nothing. The migration then succeeds, gets
 * recorded, and has written nothing — the same "recorded as applied but the SQL
 * never really ran" shape that took production's login down in July, but quieter.
 *
 * One connection also makes the advisory lock behave: pg_advisory_lock is
 * session-scoped, so taking it on one pooled connection and releasing it on
 * another leaves it held until disconnect.
 *
 * Pure and exported so the URL rewriting is covered by tests.
 */
export function withSingleConnection(url) {
  if (!url) return url;
  if (/[?&]connection_limit=/.test(url)) return url;
  return url + (url.includes("?") ? "&" : "?") + "connection_limit=1";
}

/**
 * Execute one migration's SQL, statement by statement, on this process's client.
 *
 * `$executeRawUnsafe` speaks the extended query protocol, which carries exactly
 * one statement per round trip, so the file is split by {@link splitSqlStatements}
 * — a dollar-quote-aware splitter, because 412 of these statements live inside
 * PL/pgSQL bodies whose internal semicolons must not split.
 *
 * No transaction is opened. That matches what `db execute` did, and it is
 * deliberate: changing to all-or-nothing here would be a behaviour change to the
 * production migration path, and belongs in its own change with its own argument.
 * Every migration.sql in this repository is written to be idempotent precisely
 * because a partial application has always been possible.
 *
 * Exported and injectable so the execute-before-record ordering stays testable
 * without a database.
 */
export async function executeMigrationSql(prisma, name) {
  const sql = readFileSync(join(migrationsDir, name, "migration.sql"), "utf8");
  const statements = splitSqlStatements(sql);
  for (const statement of statements) {
    await prisma.$executeRawUnsafe(statement);
  }
  return statements.length;
}

/**
 * Apply ONE migration: execute its SQL, THEN record it.
 *
 * EXECUTE BEFORE RECORD IS THE WHOLE POINT. If execute throws, the record never
 * happens, so the migration stays pending and re-runs next time (every
 * migration.sql is idempotent). The reverse order would mark a migration applied
 * that never ran — the failure that took production's login down in July.
 *
 * The SQL and the ledger row now genuinely run on the same connection. Earlier
 * versions of this file claimed that when it was not yet true — the SQL was still
 * running in a `prisma db execute` child process — and that claim was corrected
 * rather than left standing. It is true as of this change: both halves are issued
 * by this process, against the database it checked and locked.
 *
 * `execute` and `runner` are injectable so the ordering stays covered by tests.
 * Exported.
 */
export async function applyOne(name, childEnv, prisma, runner = run, execute = executeMigrationSql) {
  await execute(prisma, name);
  await recordApplied(prisma, name, childEnv, runner);
}

/**
 * Assert the live database contains every table and column the deployed schema
 * requires. Uses {@link classifyDiffScript}; FAILS the deploy on any missing
 * table/column rather than ship code that will 500 on it. `runDiff` is injectable
 * for tests. Exported.
 *
 * FAIL-CLOSED: a safety gate that cannot verify the schema must BLOCK the deploy,
 * never wave it through. If the diff probe itself fails (missing config, auth /
 * network failure, CLI problem), we throw — an unverifiable schema is treated as
 * unsafe, not assumed fine.
 */
export function assertSchemaObjectsPresent(childEnv, runDiff = defaultRunDiff) {
  let script;
  try {
    script = runDiff(childEnv);
  } catch (e) {
    throw new Error(
      `✗ MIGRATION INTEGRITY CHECK COULD NOT VERIFY THE SCHEMA (failing closed): ${e.message}\n` +
        "The deploy is blocked because the database schema could not be checked — fix the probe " +
        "(database URL / connectivity / prisma CLI) and redeploy.",
    );
  }

  const { missing, otherDrift } = classifyDiffScript(script);

  if (missing.length) {
    console.error(
      "\n✗ MIGRATION INTEGRITY CHECK FAILED — the database is missing objects the deployed schema requires:\n" +
        missing.map((l) => "    " + l.trim()).join("\n") +
        "\n\nThis means a migration is recorded as applied in _prisma_migrations but its SQL did not run\n" +
        "against THIS database. Re-run the relevant prisma/migrations/<name>/migration.sql against this\n" +
        "database (they are idempotent), then redeploy.\n",
    );
    throw new Error("Schema integrity check failed: database is missing required tables/columns.");
  }

  if (otherDrift.length) {
    console.warn(
      `integrity check: ${otherDrift.length} non-blocking schema difference(s) (indexes / column attributes) — review when convenient:`,
    );
    for (const l of otherDrift) console.warn("    " + l.trim());
  }
  console.log("✓ Integrity check passed — all tables and columns the deployed schema needs are present.");
}

/**
 * Refuse to migrate from a PREVIEW deployment unless that preview owns its
 * database.
 *
 * This is not hypothetical. Vercel runs this script in the build command for
 * EVERY deployment, previews included, against whatever DATABASE_URL that
 * environment provides. With previews pointed at the production database, each
 * open pull request silently migrated production — so production ran a schema
 * that no merged code knew about. It stayed invisible until a migration changed
 * a constraint the deployed code depended on: AppSetting's primary key moved to
 * a composite, every `ON CONFLICT (key)` upsert started failing with 42P10, and
 * saving ANY setting broke in production for a day and a half. A withdrawn
 * migration was also left permanently recorded, and composite tenant FKs went
 * live ahead of the code that populates them — which is what produced the
 * lead/contact foreign-key failures that looked like unrelated bugs.
 *
 * A preview must therefore prove it is isolated before it may write schema.
 * `PREVIEW_DB_ISOLATED=1` is that proof, and it is deliberately a manual
 * assertion: there is no reliable way to detect "this is a scratch database"
 * from the connection string alone, and guessing wrong is exactly the failure
 * this prevents.
 *
 * Skipping is the right failure mode, not erroring. A preview pointed at
 * production still runs correctly against the schema already there — it simply
 * cannot test its own migrations, which is a far smaller problem than corrupting
 * the live database. Production deploys are never affected.
 */
/**
 * @param {Record<string, string | undefined>} [env]
 * @param {(message: string) => void} [warn]
 * @returns {boolean}
 */
export function previewMayMigrate(env = process.env, warn = console.warn) {
  if (env.VERCEL_ENV !== "preview") return true;
  if (env.PREVIEW_DB_ISOLATED === "1") return true;

  warn(
    "\n⚠ PREVIEW DEPLOYMENT — SKIPPING MIGRATIONS.\n" +
      "  This build is a preview and has not declared an isolated database, so it will\n" +
      "  NOT apply migrations. Previews have historically shared the production\n" +
      "  DATABASE_URL, which let pull requests migrate the live database ahead of the\n" +
      "  code that was actually deployed.\n" +
      "  Give previews their own database branch, then set PREVIEW_DB_ISOLATED=1 on the\n" +
      "  Preview environment to re-enable migrations here.\n",
  );
  return false;
}

async function main() {
  // A session advisory lock must be held on a DIRECT (non-pooled) connection —
  // it is not reliable through a transaction pooler. Fall back to DATABASE_URL
  // where no unpooled URL is configured (e.g. CI's direct Postgres).
  const directUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  const childEnv = buildChildEnv(process.env);
  // connection_limit=1: see withSingleConnection. Migrations that SET a session
  // GUC and RESET it hundreds of statements later require one session, and this
  // process now issues those statements itself.
  const prisma = new PrismaClient(
    directUrl ? { datasources: { db: { url: withSingleConnection(directUrl) } } } : undefined,
  );
  let locked = false;

  try {
    // --check runs ONLY the integrity assertion (no lock, no writes) so it can be
    // used as a standalone drift probe against any database.
    if (CHECK_ONLY) {
      assertSchemaObjectsPresent(childEnv);
      await reportLedgerDrift(prisma);
      return;
    }

    // Reported on every run, before anything is applied, so drift surfaces in
    // the deploy log rather than only when somebody goes looking.
    await reportLedgerDrift(prisma);

    // Checked AFTER --check (a read-only drift probe is always safe) and BEFORE
    // the lock is taken, so a skipped preview never queues behind a real deploy.
    if (!previewMayMigrate()) return;

    // Checked BEFORE the lock and before any DDL: if the runner has been pointed
    // at the restricted application role it must stop here, not half way through
    // a migration script. One round trip.
    {
      const [privs] = await prisma.$queryRawUnsafe(
        `SELECT current_user AS role, has_schema_privilege(current_user, 'public', 'CREATE') AS can_create`,
      );
      const problem = migrationRoleProblem({
        role: String(privs?.role ?? "unknown"),
        canCreate: privs?.can_create === true,
        unpooledConfigured: Boolean(process.env.DATABASE_URL_UNPOOLED),
      });
      if (problem) throw new Error(problem);
    }

    if (!DRY_RUN) {
      // Blocks until any other in-flight migration run releases the lock.
      // pg_advisory_lock returns void, so wrap it in a subquery returning a
      // scalar Prisma can deserialise.
      await prisma.$queryRawUnsafe(`SELECT 1 AS ok FROM (SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})) _lock`);
      locked = true;
    }

    const migrations = orderedMigrations();
    const applied = await appliedNames(prisma);
    const pending = migrations.filter((name) => !applied.has(name));
    console.log(
      `${migrations.length} migrations on disk, ${applied.size} already applied, ${pending.length} pending${DRY_RUN ? " (dry run)" : ""}.`,
    );

    for (const name of migrations) {
      if (applied.has(name)) continue;
      if (DRY_RUN) {
        console.log(`would apply  ${name}`);
        continue;
      }
      console.log(`applying     ${name}`);
      await applyOne(name, childEnv, prisma);
    }

    if (pending.length === 0) console.log("Database is up to date — nothing to apply.");
    else if (!DRY_RUN) console.log(`Applied ${pending.length} migration(s).`);

    // Final safety net: the database must actually contain what the deployed
    // schema needs, however the ledger got into its current state. Skipped on a
    // dry run (which intentionally leaves genuine pending migrations unapplied).
    if (!DRY_RUN) assertSchemaObjectsPresent(childEnv);
  } finally {
    if (locked) {
      await prisma.$queryRawUnsafe(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`).catch(() => {});
    }
    await prisma.$disconnect();
  }
}

// Only run when executed directly (node scripts/apply-migrations.mjs) — importing
// this module (e.g. from a test of classifyDiffScript) must have no side effects.
const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
