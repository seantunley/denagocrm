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
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { PrismaClient } from "@prisma/client";

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

/** Default schema-diff probe: `prisma migrate diff` (DB → deployed schema). */
function defaultRunDiff(childEnv) {
  return capture(
    NPX,
    ["prisma", "migrate", "diff", "--from-url", childEnv.DATABASE_URL, "--to-schema-datamodel", schemaFile, "--script"],
    childEnv,
  );
}

/**
 * Apply ONE migration: execute its SQL, THEN record it (execute-before-resolve).
 * If execute throws, resolve never runs, so the migration stays pending and
 * re-runs next time (every migration.sql is idempotent). `runner(cmd, args, env)`
 * is injectable so the ordering is covered by tests. Exported.
 */
export function applyOne(name, childEnv, runner = run) {
  runner(NPX, ["prisma", "db", "execute", "--schema", schemaPath, "--file", join(migrationsDir, name, "migration.sql")], childEnv);
  runner(NPX, ["prisma", "migrate", "resolve", "--schema", schemaPath, "--applied", name], childEnv);
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
  const prisma = new PrismaClient(directUrl ? { datasources: { db: { url: directUrl } } } : undefined);
  let locked = false;

  try {
    // --check runs ONLY the integrity assertion (no lock, no writes) so it can be
    // used as a standalone drift probe against any database.
    if (CHECK_ONLY) {
      assertSchemaObjectsPresent(childEnv);
      return;
    }

    // Checked AFTER --check (a read-only drift probe is always safe) and BEFORE
    // the lock is taken, so a skipped preview never queues behind a real deploy.
    if (!previewMayMigrate()) return;

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
      applyOne(name, childEnv);
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
