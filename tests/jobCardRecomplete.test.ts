import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// Gap audit #18: a job card that was collected, reopened and completed again
// errored every time — ServiceRecord.jobCardId is unique and completion always
// CREATED a record.

const src = readFileSync(new URL("../src/app/actions/jobcards.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
const body = src.slice(src.indexOf("export async function completeJobCard("), src.indexOf("export async function deleteJobCard("));

test("the constraint this works around is real: one service record per job card", () => {
  assert.match(schema, /model ServiceRecord \{[\s\S]*?jobCardId\s+String\?\s+@unique/);
});

test("completing again updates the job card's service record instead of creating a second", () => {
  assert.doesNotMatch(body, /serviceRecord\.create\(/, "a create here fails the unique constraint on re-completion");
  assert.match(body, /tx\.serviceRecord\.upsert\(\{\s*where: \{ jobCardId \},/);
});

test("completion is claimed by the status move, in the same transaction, with a count check", () => {
  const tx = body.slice(body.indexOf("prisma.$transaction(async (tx) =>"));
  assert.ok(tx.length > 0, "one interactive transaction");
  const claim = tx.indexOf('where: { id: jobCardId, status: { not: "collected" } }');
  const check = tx.indexOf("if (moved.count === 0) refuse(");
  const upsert = tx.indexOf("tx.serviceRecord.upsert(");
  assert.ok(claim > 0 && check > claim && upsert > check, "claim → count check → record, in that order");
});

test("reopening is still possible (any stage but collected), so the re-complete path is reachable", () => {
  assert.match(src, /const allowed = new Set\(STAGE_VALUES\.filter\(\(s\) => s !== "collected"\)\);/);
});
