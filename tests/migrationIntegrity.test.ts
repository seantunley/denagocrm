import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
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
  recordApplied,
  isMissingLedgerTable,
  assertSchemaObjectsPresent,
  previewMayMigrate,
  auditMigrationLedger,
  executeMigrationSql,
  withSingleConnection,
  directMigrationUrlProblem,
} from "../scripts/apply-migrations.mjs";
import { splitSqlStatements } from "../scripts/lib/splitSqlStatements.mjs";

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
 * Both halves of applying a migration used to be child processes: `prisma db
 * execute` for the SQL, `prisma migrate resolve` for the ledger. Both are now
 * issued by the runner itself, on one pinned connection — which is what the
 * header's split-brain warning was really asking for.
 *
 * With one exception, stated because this comment has twice claimed more than
 * was true: on a brand-new database `_prisma_migrations` does not exist, and
 * recordApplied falls back to spawning `migrate resolve` to create it. The first
 * migration of a fresh database therefore records itself from a child process.
 *
 * The ORDER is unchanged and is what these tests protect.
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
  const noSpawn = () => assert.fail("applyOne must not spawn a process to run the SQL");
  const execute = async () => {
    order.push("execute");
    return 1;
  };
  const wrapped = {
    ...prisma,
    $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => {
      order.push("record");
      return prisma.$executeRaw(s, ...v);
    },
  };
  await applyOne("77_custom_fields", { DATABASE_URL: "x" }, wrapped, noSpawn, execute);
  assert.deepEqual(order, ["execute", "record"], "SQL first, ledger second");
  assert.equal(prisma.writes.length, 1, "exactly one ledger row");
  assert.match(prisma.writes[0], /77_custom_fields/, "and it names this migration");
});

test("applyOne: if execute throws, the migration is NEVER recorded (stays pending)", async () => {
  // The July outage in one line: a migration recorded as applied whose SQL never
  // ran leaves a missing column and a database that believes it is up to date.
  const prisma = fakePrisma();
  const execute = async () => {
    throw new Error("SQL failed");
  };
  await assert.rejects(
    () => applyOne("77_custom_fields", { DATABASE_URL: "x" }, prisma, () => {}, execute),
    /SQL failed/,
  );
  assert.deepEqual(prisma.writes, [], "the ledger must not be written after a failed execute");
});

test("executeMigrationSql: sends each statement separately, in file order", async () => {
  // The extended query protocol carries one statement per round trip, so this
  // must not hand the whole file over in a single call.
  const sent: string[] = [];
  const prisma = { $executeRawUnsafe: async (sql: string) => void sent.push(sql) };
  const count = await executeMigrationSql(prisma as never, "77_custom_fields");

  assert.equal(count, sent.length, "the reported count is what was actually sent");
  assert.ok(sent.length > 1, "a real migration is more than one statement");
  for (const statement of sent) {
    assert.ok(!statement.trim().endsWith(";"), `statement should not carry its separator: ${statement.slice(0, 40)}`);
  }
  const file = readFileSync(join(root, "prisma", "migrations", "77_custom_fields", "migration.sql"), "utf8");
  let cursor = 0;
  for (const statement of sent) {
    const at = file.indexOf(statement, cursor);
    assert.notEqual(at, -1, "each statement comes verbatim from the file");
    cursor = at + statement.length;
  }
});

test("withSingleConnection: pins the runner to one session", () => {
  // Ten migrations SET a session GUC and RESET it many statements later — up to
  // 80 statements apart. Pooling would put those statements on different
  // sessions, so the SET would not apply and RLS would silently filter the
  // writes it was protecting.
  const quiet = () => {};
  assert.equal(withSingleConnection("postgres://h/db", quiet), "postgres://h/db?connection_limit=1");
  assert.equal(
    withSingleConnection("postgres://h/db?sslmode=require", quiet),
    "postgres://h/db?sslmode=require&connection_limit=1",
  );
  assert.equal(withSingleConnection(undefined, quiet), undefined);
});

test("withSingleConnection: a configured connection_limit can NEVER survive", () => {
  // The first version of this returned the URL untouched when it already had a
  // connection_limit, and a test blessed connection_limit=5 as "an explicit
  // choice left alone". That contradicts the whole reason the pin exists: if one
  // session is a correctness requirement, a configured 5 is the bug, not a
  // preference. Five connections reopen exactly the silent failure this closes.
  const quiet = () => {};
  for (const url of [
    "postgres://h/db?connection_limit=5",
    "postgres://h/db?connection_limit=0",
    "postgres://h/db?sslmode=require&connection_limit=17",
    "postgres://h/db?connection_limit=5&sslmode=require",
    "postgres://h/db?connection_limit=5&connection_limit=9",
  ]) {
    const out = withSingleConnection(url, quiet);
    assert.equal(
      [...out.matchAll(/connection_limit=(\d+)/g)].map((m) => m[1]).join(","),
      "1",
      `exactly one connection_limit, and it must be 1 — got ${out}`,
    );
  }
  // Other parameters survive the rewrite.
  assert.match(withSingleConnection("postgres://h/db?connection_limit=5&sslmode=require", quiet), /sslmode=require/);
  // A credential is never re-encoded on the way through.
  assert.match(
    withSingleConnection("postgres://user:pass%40word@db.example.com/x?connection_limit=5", quiet),
    /user:pass%40word@db\.example\.com/,
  );
});

test("withSingleConnection: overriding a deliberate value is reported, not silent", () => {
  const warnings: string[] = [];
  withSingleConnection("postgres://h/db?connection_limit=5", (m: string) => warnings.push(m));
  assert.equal(warnings.length, 1, "an override should say so");
  assert.match(warnings[0], /connection_limit=5/);

  const quiet: string[] = [];
  withSingleConnection("postgres://h/db?connection_limit=1", (m: string) => quiet.push(m));
  assert.deepEqual(quiet, [], "already correct — nothing to report");
});

test("directMigrationUrlProblem: a pooled URL is refused in EVERY environment", () => {
  // The first version gated both checks on VERCEL_ENV=production, and a test
  // here asserted `preview + pooled URL → allowed`. That blessed the exact
  // hazard: previewMayMigrate lets an isolated preview (PREVIEW_DB_ISOLATED=1)
  // migrate, and with no DATABASE_URL_UNPOOLED it falls back to a pooled
  // DATABASE_URL — so the whole statement-by-statement run went through a
  // transaction pooler, which is what connection_limit=1 cannot fix.
  //
  // Session continuity is a property of the CONNECTION, not the environment.
  const pooled = "postgres://user:pass@ep-x-pooler.example.neon.tech/db";
  const direct = "postgres://user:pass@ep-x.example.neon.tech/db";
  const ciLocal = "postgres://localhost:5432/denagocrm_test";
  const refused = (o: { vercelEnv?: string; unpooled?: string; resolved?: string }) =>
    directMigrationUrlProblem(o) ?? "";

  // preview — the case that used to be waved through
  assert.match(
    refused({ vercelEnv: "preview", unpooled: undefined, resolved: pooled }),
    /POOLED endpoint/,
    "an isolated preview must not migrate through a pooler either",
  );
  assert.equal(directMigrationUrlProblem({ vercelEnv: "preview", unpooled: direct, resolved: direct }), null);

  // manual / disaster-recovery runs have no VERCEL_ENV at all
  assert.match(
    refused({ vercelEnv: undefined, unpooled: pooled, resolved: pooled }),
    /POOLED endpoint/,
    "a hand-run recovery migration is the last place to lose session continuity",
  );

  // CI connects straight to a Postgres container and has no unpooled variable
  assert.equal(directMigrationUrlProblem({ vercelEnv: undefined, unpooled: undefined, resolved: ciLocal }), null);

  // production
  assert.match(
    refused({ vercelEnv: "production", unpooled: undefined, resolved: pooled }),
    /DATABASE_URL_UNPOOLED is not set/,
    "…and when the variable is simply missing, say THAT — it names the cause",
  );
  assert.match(
    refused({ vercelEnv: "production", unpooled: pooled, resolved: pooled }),
    /POOLED endpoint/,
    "a direct URL that is actually pooled must refuse too",
  );
  assert.equal(directMigrationUrlProblem({ vercelEnv: "production", unpooled: direct, resolved: direct }), null);
});

test("session GUCs really do span separate statements, in every migration that uses one", () => {
  // This is the evidence for withSingleConnection, recomputed rather than
  // asserted from memory — my first pass at this counted three migrations by
  // grepping for SET at column 0, and missed seven indented ones.
  //
  // The property that matters is not the count: it is that a SET and the
  // statements it protects land in DIFFERENT statements, so pooling could put
  // them on different sessions. If a migration ever contains a SET with nothing
  // after it, it does not need pinning and this test should say so.
  const dir = join(root, "prisma", "migrations");
  const spans: { name: string; between: number }[] = [];

  for (const name of readdirSync(dir).filter((n) => existsSync(join(dir, n, "migration.sql")))) {
    const parts = splitSqlStatements(readFileSync(join(dir, name, "migration.sql"), "utf8"));
    const isSet: number[] = [];
    const isReset: number[] = [];
    parts.forEach((p, i) => {
      const body = p.replace(/^(\s|--[^\n]*\n)*/, "");
      if (/^SET\s+app\./i.test(body)) isSet.push(i);
      if (/^RESET\s+app\./i.test(body)) isReset.push(i);
    });
    if (!isSet.length) continue;
    const last = isReset.length ? isReset[isReset.length - 1] : parts.length - 1;
    spans.push({ name, between: last - isSet[0] - 1 });
  }

  // 10 → 14: the four chatbot backfills now wrap themselves in
  // SET app.bypass_rls, because they write FORCE-RLS tables and would otherwise
  // match zero rows, succeed, and be recorded as applied where the migrating role
  // does not bypass RLS. As the comment above says, the count is not the property
  // — the span between SET and its last dependent statement is — but it is worth
  // knowing when the number moves and why.
  assert.equal(spans.length, 14, "fourteen migrations set a session GUC");
  for (const { name, between } of spans) {
    assert.ok(between > 0, `${name}: a SET with no following statement would not need session pinning`);
  }
  const widest = spans.reduce((a, b) => (b.between > a.between ? b : a));
  assert.equal(widest.name, "20260805230000_signing_trust_platform");
  assert.ok(widest.between >= 80, `widest span should be ~80 statements, saw ${widest.between}`);
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

/**
 * A BRAND-NEW DATABASE HAS NO LEDGER TABLE YET.
 *
 * `prisma migrate resolve` creates `_prisma_migrations` as a side effect, which is
 * why the two-spawn version never had to think about it. Replacing that spawn with
 * a direct insert broke the very first migration on an empty database:
 *
 *   relation "_prisma_migrations" does not exist
 *
 * CI found it on the first run, which is where a change to the migration runner
 * should be found. The fallback lets Prisma create the table with its OWN
 * definition rather than copying that DDL here, where it would quietly rot the
 * next time Prisma changed a column.
 */

test("a missing ledger table falls back to Prisma, which creates it", async () => {
  const spawned: string[][] = [];
  const prisma = {
    $executeRaw: () => Promise.reject(Object.assign(new Error("boom"), { meta: { code: "42P01" } })),
  };
  await recordApplied(prisma, "77_custom_fields", { DATABASE_URL: "x" }, (_c: string, a: string[]) => {
    spawned.push(a.slice(0, 3));
  });
  assert.deepEqual(spawned, [["prisma", "migrate", "resolve"]], "exactly one fallback spawn");
});

test("any OTHER database error is rethrown, never swallowed", () => {
  // A catch-all here would turn a real failure into a silent fallback, and the
  // migration would be recorded as applied on a database that rejected the write.
  const prisma = {
    $executeRaw: () => Promise.reject(Object.assign(new Error("connection refused"), { meta: { code: "08006" } })),
  };
  return assert.rejects(
    () => recordApplied(prisma, "77_custom_fields", { DATABASE_URL: "x" }, () => {
      throw new Error("must not fall back");
    }),
    /connection refused/,
  );
});

test("the missing-table check recognises both signals and nothing else", () => {
  assert.equal(isMissingLedgerTable({ meta: { code: "42P01" } }), true);
  assert.equal(isMissingLedgerTable({ message: 'relation "_prisma_migrations" does not exist' }), true);
  assert.equal(isMissingLedgerTable({ meta: { code: "08006" } }), false);
  assert.equal(isMissingLedgerTable({ message: 'relation "Contact" does not exist' }), false);
  assert.equal(isMissingLedgerTable(undefined), false);
});
