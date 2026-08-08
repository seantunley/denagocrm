import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// The migration runner's integrity guard. Importing must be side-effect-free
// (the runner only executes main() when invoked directly), so this is safe.
import {
  classifyDiffScript,
  buildChildEnv,
  applyOne,
  migrationChecksum,
  assertSchemaObjectsPresent,
  previewMayMigrate,
  auditMigrationLedger,
} from "../scripts/apply-migrations.mjs";

// ── classifyDiffScript: the block-vs-warn rule ──────────────────────────────

// The exact drift that caused the 2026-07-22 login outage: tenant_foundation was
// recorded as applied but its SQL never ran, so the DB lacked UserSession.tenantId
// and the Tenant table. The guard MUST flag these as deploy-blocking.
test("classifyDiffScript: a missing column blocks the deploy", () => {
  const script = ['-- AlterTable', 'ALTER TABLE "UserSession" ADD COLUMN "tenantId" TEXT;'].join("\n");
  assert.equal(classifyDiffScript(script).missing.length, 1);
});

test("classifyDiffScript: a missing table blocks the deploy", () => {
  const script = ['-- CreateTable', 'CREATE TABLE "Tenant" (', '    "id" TEXT NOT NULL', ");"].join("\n");
  assert.equal(classifyDiffScript(script).missing.length, 1);
});

// Objects the DB has but the schema does not (e.g. tables from other branches)
// surface as DROP statements — harmless to deployed code, must NOT block.
test("classifyDiffScript: extra DB objects (DROP) never block the deploy", () => {
  const script = [
    'DROP TABLE "SomeOtherBranchTable";',
    'ALTER TABLE "X" DROP CONSTRAINT "X_y_fkey";',
    'DROP INDEX "X_y_idx";',
  ].join("\n");
  const { missing, otherDrift } = classifyDiffScript(script);
  assert.equal(missing.length, 0);
  assert.equal(otherDrift.length, 0);
});

test("classifyDiffScript: index / column-attribute drift warns but does not block", () => {
  const script = [
    'CREATE UNIQUE INDEX "StockUnit_stockNumber_key" ON "StockUnit"("stockNumber");',
    'ALTER TABLE "StockUnit" ALTER COLUMN "salePriceCents" DROP NOT NULL;',
  ].join("\n");
  const { missing, otherDrift } = classifyDiffScript(script);
  assert.equal(missing.length, 0);
  assert.equal(otherDrift.length, 2);
});

test("classifyDiffScript: an empty (no-drift) diff blocks nothing", () => {
  const { missing, otherDrift } = classifyDiffScript("");
  assert.equal(missing.length, 0);
  assert.equal(otherDrift.length, 0);
});

// ── buildChildEnv: command pinning ──────────────────────────────────────────

test("buildChildEnv: pins both URLs to the UNPOOLED (direct) database", () => {
  const env = buildChildEnv({
    DATABASE_URL: "postgres://pooler/db",
    DATABASE_URL_UNPOOLED: "postgres://direct/db",
    OTHER: "keep",
  });
  assert.equal(env.DATABASE_URL, "postgres://direct/db");
  assert.equal(env.DATABASE_URL_UNPOOLED, "postgres://direct/db");
  assert.equal(env.OTHER, "keep");
});

test("buildChildEnv: falls back to DATABASE_URL when no unpooled URL is set (CI)", () => {
  const env = buildChildEnv({ DATABASE_URL: "postgres://direct/db" });
  assert.equal(env.DATABASE_URL, "postgres://direct/db");
  assert.equal(env.DATABASE_URL_UNPOOLED, "postgres://direct/db");
});

test("buildChildEnv: no DB url configured → does not invent one, returns a copy", () => {
  const env = buildChildEnv({ SOMETHING: "x" });
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.SOMETHING, "x");
});

// ── applyOne: execute-before-resolve ordering ───────────────────────────────

/**
 * The recording step used to be a second `npx prisma migrate resolve` process.
 * It is now a direct insert on the runner's own connection — the same connection
 * that just applied the SQL, which is what the header's split-brain warning was
 * really asking for. The ORDER is unchanged and is what these tests protect.
 */

/** Enough of a Prisma client to observe whether the ledger row was written. */
function fakePrisma() {
  const writes: string[] = [];
  return {
    writes,
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      void strings;
      // Every interpolated value, not a fixed index: `now()` is literal SQL and
      // not a parameter, so counting positions is a mistake waiting to happen.
      writes.push(values.map(String).join("|"));
      return Promise.resolve(1);
    },
  };
}

test("applyOne: executes the SQL BEFORE recording it as applied", async () => {
  const order: string[] = [];
  const prisma = fakePrisma();
  const spy = (_cmd: string, args: string[]) => order.push(args.slice(0, 2).join(" "));
  const wrapped = {
    ...prisma,
    $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => {
      order.push("record");
      return prisma.$executeRaw(s, ...v);
    },
  };
  await applyOne("77_custom_fields", { DATABASE_URL: "x" }, wrapped, spy);
  assert.deepEqual(order, ["prisma db", "record"], "SQL first, ledger second");
  assert.equal(prisma.writes.length, 1, "exactly one ledger row");
  assert.match(prisma.writes[0], /77_custom_fields/, "and it names this migration");
});

test("applyOne: if execute throws, the migration is NEVER recorded (stays pending)", async () => {
  // The July outage in one line: a migration recorded as applied whose SQL never
  // ran leaves a missing column and a database that believes it is up to date.
  const prisma = fakePrisma();
  const spy = (_cmd: string, args: string[]) => {
    if (args[1] === "db") throw new Error("SQL failed");
  };
  await assert.rejects(
    () => applyOne("77_custom_fields", { DATABASE_URL: "x" }, prisma, spy),
    /SQL failed/,
  );
  assert.deepEqual(prisma.writes, [], "the ledger must not be written after a failed execute");
});

test("the recorded checksum is the SHA-256 of the migration file", () => {
  // Prisma computes it this way, verified against production rows before relying
  // on it. A wrong checksum does not fail here — it makes a LATER `prisma migrate`
  // run report the migration as modified, which is a confusing way to find out.
  const name = "77_custom_fields";
  const file = readFileSync(join(root, "prisma", "migrations", name, "migration.sql"));
  const expected = createHash("sha256").update(file).digest("hex");
  assert.equal(migrationChecksum(name), expected);
  assert.match(migrationChecksum(name), /^[0-9a-f]{64}$/);
});

// ── assertSchemaObjectsPresent: fail-closed + block/pass ────────────────────

test("assertSchemaObjectsPresent: missing table/column → throws (blocks deploy)", () => {
  const runDiff = () => 'ALTER TABLE "UserSession" ADD COLUMN "tenantId" TEXT;';
  assert.throws(() => assertSchemaObjectsPresent({}, runDiff), /missing required tables\/columns/);
});

test("assertSchemaObjectsPresent: clean schema → passes", () => {
  assert.doesNotThrow(() => assertSchemaObjectsPresent({}, () => ""));
});

test("assertSchemaObjectsPresent: non-blocking drift only → passes", () => {
  const runDiff = () => 'CREATE UNIQUE INDEX "StockUnit_stockNumber_key" ON "StockUnit"("stockNumber");';
  assert.doesNotThrow(() => assertSchemaObjectsPresent({}, runDiff));
});

// A safety gate that cannot verify the schema must FAIL CLOSED — never wave the
// deploy through on a probe error (missing config / auth / network / CLI fault).
test("assertSchemaObjectsPresent: probe failure → throws (fail-closed, no silent pass)", () => {
  const runDiff = () => {
    throw new Error("connect ECONNREFUSED");
  };
  assert.throws(() => assertSchemaObjectsPresent({}, runDiff), /could not verify the schema/i);
});

// ── previewMayMigrate: previews must not write schema to a shared database ───

// The failure this prevents: Vercel runs the migration runner in the build
// command for EVERY deployment. With previews pointed at the production
// database, each open pull request migrated production ahead of the code that
// was actually deployed — which is how AppSetting's primary key changed under a
// running app and broke every settings save with 42P10.
test("previewMayMigrate: a preview with no isolated database does NOT migrate", () => {
  const warnings = [];
  const may = previewMayMigrate({ VERCEL_ENV: "preview" }, (m) => warnings.push(m));
  assert.equal(may, false);
  assert.equal(warnings.length, 1, "skipping must be announced, never silent");
});

test("previewMayMigrate: a preview that declares an isolated database may migrate", () => {
  assert.equal(
    previewMayMigrate({ VERCEL_ENV: "preview", PREVIEW_DB_ISOLATED: "1" }, () => {}),
    true,
  );
});

// Only the literal "1" counts. A stray "true"/"yes"/"0" must not be read as
// consent to write schema to whatever database this preview happens to hold.
test("previewMayMigrate: only PREVIEW_DB_ISOLATED=1 counts as isolation", () => {
  for (const value of ["true", "yes", "0", "", "01"]) {
    assert.equal(
      previewMayMigrate({ VERCEL_ENV: "preview", PREVIEW_DB_ISOLATED: value }, () => {}),
      false,
      `PREVIEW_DB_ISOLATED=${JSON.stringify(value)} must not enable migrations`,
    );
  }
});

// Production deploys and local/CI runs are unaffected — the guard is preview-only.
test("previewMayMigrate: production and non-Vercel runs always migrate", () => {
  assert.equal(previewMayMigrate({ VERCEL_ENV: "production" }, () => {}), true);
  assert.equal(previewMayMigrate({ VERCEL_ENV: "development" }, () => {}), true);
  assert.equal(previewMayMigrate({}, () => {}), true);
});

// ── auditMigrationLedger: the bookkeeping nobody was reading ────────────────

/**
 * `assertSchemaObjectsPresent` asks whether the database has the tables and
 * columns the schema needs. Nothing asked whether the migration LEDGER made
 * sense, so production accumulated 15 records for migrations that no longer
 * exist and one recorded as rolled back — unnoticed until someone looked by
 * hand. Neither breaks this runner, which only iterates directories it can see,
 * but `prisma migrate deploy` refuses to run at all while a rolled-back record
 * exists, so the fallback path was quietly unusable.
 */

test("a record with no migration on disk is reported", () => {
  const { phantom } = auditMigrationLedger(
    [
      { migration_name: "1_real", finished_at: new Date(), rolled_back_at: null },
      { migration_name: "55_withdrawn", finished_at: new Date(), rolled_back_at: null },
    ],
    ["1_real"],
  );
  assert.deepEqual(phantom, ["55_withdrawn"]);
});

test("an unfinished or rolled-back record is reported", () => {
  const { unfinished } = auditMigrationLedger(
    [
      { migration_name: "1_ok", finished_at: new Date(), rolled_back_at: null },
      { migration_name: "2_died", finished_at: null, rolled_back_at: null },
      { migration_name: "3_undone", finished_at: new Date(), rolled_back_at: new Date() },
    ],
    ["1_ok", "2_died", "3_undone"],
  );
  assert.deepEqual(unfinished, ["2_died", "3_undone"]);
});

test("a healthy ledger reports nothing", () => {
  const result = auditMigrationLedger(
    [{ migration_name: "1_ok", finished_at: new Date(), rolled_back_at: null }],
    ["1_ok", "2_not_yet_applied"],
  );
  // A migration on disk that has NOT been applied is not drift — it is simply
  // pending, and applying it is this runner's whole job.
  assert.deepEqual(result, { phantom: [], unfinished: [] });
});
