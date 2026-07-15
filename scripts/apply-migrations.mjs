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
// Usage:
//   node scripts/apply-migrations.mjs            apply pending migrations
//   node scripts/apply-migrations.mjs --dry-run  report decisions, change nothing

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PrismaClient } from "@prisma/client";

const DRY_RUN = process.argv.includes("--dry-run");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "prisma", "migrations");
const schemaPath = join(root, "prisma");

/** Migration directories with a migration.sql, ordered by their numeric prefix. */
function orderedMigrations() {
  return readdirSync(migrationsDir)
    .filter((name) => /^\d+_/.test(name) && existsSync(join(migrationsDir, name, "migration.sql")))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
}

async function appliedNames() {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL',
    );
    return new Set(rows.map((r) => r.migration_name));
  } catch {
    // Table absent → brand-new database, nothing applied yet.
    return new Set();
  } finally {
    await prisma.$disconnect();
  }
}

function run(cmd, args) {
  execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
}

async function main() {
  const migrations = orderedMigrations();
  const applied = await appliedNames();

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
    run("npx", ["prisma", "db", "execute", "--schema", schemaPath, "--file", join(migrationsDir, name, "migration.sql")]);
    run("npx", ["prisma", "migrate", "resolve", "--schema", schemaPath, "--applied", name]);
  }

  if (pending.length === 0) console.log("Database is up to date — nothing to apply.");
  else if (!DRY_RUN) console.log(`Applied ${pending.length} migration(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
