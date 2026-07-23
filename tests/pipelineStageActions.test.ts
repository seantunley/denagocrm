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

test("migration backfills one deterministic open test-drive stage per pipeline", () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "entryAction"/);
  assert.match(migration, /ROW_NUMBER\(\) OVER \([\s\S]+PARTITION BY candidate\."pipelineId"/);
  assert.match(migration, /candidate\."name" ILIKE '%test%'/);
  assert.match(migration, /COALESCE\(candidate\."isClosed", false\) = false/);
  assert.match(migration, /ranked\.rn = 1/);
  assert.match(migration, /configured\."entryAction" IS NOT NULL/);
});

test("database enforces one required action of each kind per pipeline", () => {
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS "PipelineStage_pipeline_entryAction_key"[\s\S]+WHERE "entryAction" IS NOT NULL/,
  );
  assert.match(migration, /DROP CONSTRAINT IF EXISTS "PipelineStage_entryAction_check"/);
  assert.match(migration, /VALIDATE CONSTRAINT "PipelineStage_entryAction_check"/);
});
