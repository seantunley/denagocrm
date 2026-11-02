import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { stepNumbersLine } from "../src/lib/flowStepNumbers";

// Node-RED's node status, as live numbers on each step (Sean, 2026-11-02).
test("a step shows how many reached it; a question also shows answered and dropped off; nothing when none", () => {
  assert.equal(stepNumbersLine("message", { reached: 142, interacted: 0 }), "142 reached");
  assert.equal(stepNumbersLine("choice", { reached: 142, interacted: 130 }), "142 reached · 130 answered · 12 dropped off");
  assert.equal(stepNumbersLine("capture", { reached: 5, interacted: 7 }), "5 reached · 7 answered · 0 dropped off", "never negative");
  assert.equal(stepNumbersLine("message", { reached: 0, interacted: 0 }), null);
  assert.equal(stepNumbersLine("message", undefined), null);
});

test("the numbers come from the flow's own published versions, last 30 days, and can be switched off", () => {
  const page = readFileSync("src/app/(app)/bot-builder/[id]/page.tsx", "utf8");
  assert.match(page, /botFlowVersion\.findMany\(\{ where: \{ flowId: id, tenantId: await builderTenantId\(\) \}/);
  assert.match(page, /getBotFlowVersionAnalytics\(versionIds, \{ occurredFrom: new Date\(Date\.now\(\) - STEP_NUMBERS_DAYS \* 86_400_000\) \}\)/);
  const builder = readFileSync("src/components/FlowBuilder.tsx", "utf8");
  assert.match(builder, /<StepNumbersContext\.Provider value=\{showNumbers \? stepNumbers : null\}>/);
});
