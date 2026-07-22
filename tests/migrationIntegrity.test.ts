import assert from "node:assert/strict";
import { test } from "node:test";
// The migration runner's integrity guard. Importing must be side-effect-free
// (the runner only executes main() when invoked directly), so this is safe.
import { classifyDiffScript } from "../scripts/apply-migrations.mjs";

// The exact drift that caused the 2026-07-22 login outage: tenant_foundation was
// recorded as applied but its SQL never ran, so the DB lacked UserSession.tenantId
// and the Tenant table. The guard MUST flag these as deploy-blocking.
test("classifyDiffScript: a missing column blocks the deploy", () => {
  const script = [
    "-- AlterTable",
    'ALTER TABLE "UserSession" ADD COLUMN "tenantId" TEXT;',
  ].join("\n");
  const { missing } = classifyDiffScript(script);
  assert.equal(missing.length, 1);
});

test("classifyDiffScript: a missing table blocks the deploy", () => {
  const script = [
    "-- CreateTable",
    'CREATE TABLE "Tenant" (',
    '    "id" TEXT NOT NULL,',
    '    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")',
    ");",
  ].join("\n");
  const { missing } = classifyDiffScript(script);
  assert.equal(missing.length, 1);
});

// Objects the DB has but the deployed schema does not (e.g. tables from other
// branches) surface as DROP statements — harmless to deployed code, must NOT
// block the deploy.
test("classifyDiffScript: extra DB objects (DROP) never block the deploy", () => {
  const script = [
    "-- DropTable",
    'DROP TABLE "SomeOtherBranchTable";',
    "-- DropForeignKey",
    'ALTER TABLE "X" DROP CONSTRAINT "X_y_fkey";',
    "-- DropIndex",
    'DROP INDEX "X_y_idx";',
  ].join("\n");
  const { missing, otherDrift } = classifyDiffScript(script);
  assert.equal(missing.length, 0);
  assert.equal(otherDrift.length, 0);
});

// Missing indexes / column-attribute drift are real but non-blocking: reported
// as warnings, not deploy failures (matches the benign pre-existing prod drift).
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
