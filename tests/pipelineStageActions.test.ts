import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PIPELINE_STAGE_ACTION_META,
  parsePipelineStageAction,
} from "../src/lib/pipelineStageActions";

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

test("migration preserves existing test-drive behaviour while removing the runtime name convention", () => {
  const migration = readFileSync(
    join(process.cwd(), "prisma", "migrations", "79_pipeline_stage_actions", "migration.sql"),
    "utf8",
  );
  assert.match(migration, /ADD COLUMN "entryAction"/);
  assert.match(migration, /SET "entryAction" = 'book_test_drive'/);
  assert.match(migration, /WHERE "name" ILIKE '%test%'/);
});
