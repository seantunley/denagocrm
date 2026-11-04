import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { stepFailuresToLog } from "../src/lib/flow";

test("a failed chatbot step reaches the System Log; routine misses and successes do not", () => {
  const logged = stepFailuresToLog([
    { action: "crm_tag", ok: false, reason: "No customer record to tag" },
    { action: "booking_service", ok: false },
    { action: "notify", ok: false },
    { action: "journey_start", ok: true },
    { action: "knowledge_answer", ok: false },
    { action: "ai_extract", ok: false },
  ]).map((a) => a.action);
  assert.deepEqual(logged, ["crm_tag", "booking_service", "notify"]);
});

test("both conversation runners log a turn's failed steps", () => {
  for (const file of ["src/lib/flowRun.ts", "src/lib/flowSession.ts"]) {
    assert.match(readFileSync(file, "utf8"), /await runFlow\([^\n]*\n\s*await logFailedSteps\(/, `${file} must log failed steps right after the turn runs`);
  }
});
