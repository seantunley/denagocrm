import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PIPELINE_STAGE_ACTION_META,
  parsePipelineStageAction,
} from "../src/lib/pipelineStageActions";

const migration = readFileSync(
  join(process.cwd(), "prisma", "migrations", "79_pipeline_stage_actions", "migration.sql"),
  "utf8",
);
const pipelineSource = readFileSync(
  join(process.cwd(), "src", "lib", "pipelines.ts"),
  "utf8",
);

test("pipeline stage actions accept only supported action identifiers", () => {
  assert.equal(parsePipelineStageAction("book_test_drive"), "book_test_drive");
  assert.equal(parsePipelineStageAction(""), null);
  assert.equal(parsePipelineStageAction("send_anything"), null);
});

test("test-drive stage action explains its required workflow", () => {
  assert.match(
    PIPELINE_STAGE_ACTION_META.book_test_drive.description,
    /date, time and location/i,
  );
});

test("migration backfills one deterministic open test-drive stage per tenant pipeline", () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "entryAction"/);
  assert.match(
    migration,
    /PARTITION BY candidate\."tenantId", candidate\."pipelineId"/,
  );
  assert.match(migration, /candidate\."name" ILIKE '%test%'/);
  assert.match(migration, /COALESCE\(candidate\."isClosed", false\) = false/);
  assert.match(migration, /configured\."tenantId" IS NOT DISTINCT FROM candidate\."tenantId"/);
  assert.match(migration, /ranked\.rn = 1/);
});

test("database enforces one required action per tenant pipeline", () => {
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS "PipelineStage_tenant_pipeline_entryAction_key"[\s\S]+"tenantId", "pipelineId", "entryAction"/,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS "PipelineStage_legacy_pipeline_entryAction_key"[\s\S]+WHERE "tenantId" IS NULL/,
  );
  assert.match(migration, /UPDATE "PipelineStage"[\s\S]+COALESCE\("isClosed", false\) = true/);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS "PipelineStage_entryAction_check"/);
  assert.match(migration, /VALIDATE CONSTRAINT "PipelineStage_entryAction_check"/);
});

test("raw pipeline stage helpers obey the active tenant scope", () => {
  assert.match(pipelineSource, /currentScopeClass\(\)/);
  assert.match(pipelineSource, /writeTenantId\(\)/);
  assert.match(pipelineSource, /INSERT INTO "PipelineStage"[\s\S]+"tenantId"/);
  assert.match(pipelineSource, /function tenantFilter/);
  assert.match(pipelineSource, /WHERE "id" = \$\{stageId\} \$\{scope\}/);
  assert.match(pipelineSource, /FROM "Lead"[\s\S]+"deletedAt" IS NULL \$\{scope\}/);
});
