import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const queue = readFileSync(new URL("../src/lib/surveyDistributionQueue.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../prisma/migrations/20260724200000_survey_distributions_queue/migration.sql", import.meta.url), "utf8");

test("survey queue uses atomic skip-locked claims", () => {
  assert.match(queue, /FOR UPDATE OF r SKIP LOCKED/);
  assert.match(queue, /status\" = 'sending'/);
});

test("survey queue applies delivery-time communication policy", () => {
  assert.match(queue, /canContactPerson/);
  assert.match(queue, /survey_marketing/);
  assert.match(queue, /survey_transactional/);
});

test("survey queue scopes raw queries to the active tenant", () => {
  const tenantPredicates = queue.match(/tenantId\" IS NOT DISTINCT FROM/g) ?? [];
  assert.ok(tenantPredicates.length >= 10);
});

test("distribution migration provides retry reminder and suppression fields", () => {
  for (const field of ["attemptCount", "nextAttemptAt", "suppressionReason", "reminderCount", "inviteSentAt", "distributionId"]) {
    assert.match(migration, new RegExp(field));
  }
});
