import assert from "node:assert/strict";
import { test } from "node:test";
// The migration runner's integrity guard. Importing must be side-effect-free
// (the runner only executes main() when invoked directly), so this is safe.
import {
  classifyDiffScript,
  buildChildEnv,
  applyOne,
  assertSchemaObjectsPresent,
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

test("applyOne: executes the SQL BEFORE recording it as applied", () => {
  const calls: string[] = [];
  const spy = (_cmd: string, args: string[]) => calls.push(args.slice(0, 2).join(" "));
  applyOne("77_custom_fields", { DATABASE_URL: "x" }, spy);
  assert.deepEqual(calls, ["prisma db", "prisma migrate"]);
});

test("applyOne: if execute throws, the migration is NEVER recorded (stays pending)", () => {
  const calls: string[] = [];
  const spy = (_cmd: string, args: string[]) => {
    calls.push(args[1]);
    if (args[1] === "db") throw new Error("SQL failed");
  };
  assert.throws(() => applyOne("77_custom_fields", { DATABASE_URL: "x" }, spy), /SQL failed/);
  assert.deepEqual(calls, ["db"], "resolve must not run after a failed execute");
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
