import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseEvaluationExpectation, parseEvaluationTurns } from "../src/lib/flowEvaluationContract";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("evaluation turns support text, exact choices, and simulated files with hard bounds", () => {
  assert.deepEqual(parseEvaluationTurns("choice: Book service\nRover XL\nfile: licence.jpg"), [
    { kind: "choice", value: "Book service" },
    { kind: "text", value: "Rover XL" },
    { kind: "file", value: "licence.jpg" },
  ]);
  assert.throws(() => parseEvaluationTurns(""), /at least one/);
  assert.throws(() => parseEvaluationTurns(Array.from({ length: 13 }, (_, index) => `turn ${index}`).join("\n")), /no more than 12/);
  assert.throws(() => parseEvaluationTurns("x".repeat(241)), /exceeds 240/);
});

test("evaluation expectations validate outcome and paired variable assertions", () => {
  assert.deepEqual(parseEvaluationExpectation({ outcome: "handoff", replyContains: "team", variableKey: "model!", variableValue: "Rover XL" }), {
    outcome: "handoff",
    replyContains: "team",
    variable: { key: "model", value: "Rover XL" },
  });
  assert.throws(() => parseEvaluationExpectation({ outcome: "other" }), /expected final outcome/);
  assert.throws(() => parseEvaluationExpectation({ outcome: "waiting", variableKey: "model" }), /supplied together/);
});

test("saved evaluations are tenant-owned, RLS forced, bounded, and flow-fenced", () => {
  const migration = src("prisma/migrations/20260830230000_bot_flow_evaluations/migration.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "BotFlowEvaluation"/);
  assert.match(migration, /BotFlowEvaluation_tenant_flow_fkey/);
  assert.match(migration, /REFERENCES "BotFlow"\("tenantId", "id"\)/);
  assert.match(migration, /jsonb_array_length\("turns"\) <= 12/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /"tenantId" = current_setting\('app\.current_tenant', true\)/);
  assert.match(migration, /BotFlowEvaluation_flowVersionId_fkey[\s\S]+ON DELETE RESTRICT/);
});

test("evaluation actions validate every flow and version against the acting tenant", () => {
  const action = src("src/app/actions/flowEvaluations.ts");
  assert.match(action, /await requireOwner\(\)/);
  assert.match(action, /const tenantId = await builderTenantId\(\)/);
  assert.ok((action.match(/where: \{ id: [^,]+, tenantId \}/g) ?? []).length >= 3);
  assert.match(action, /WHERE "tenantId" = \$\{tenantId\}/);
  assert.match(action, /AND "flowId" = \$\{flowId\}/);
  assert.match(action, /AND "id" = \$\{versionId\}/);
  assert.match(action, /deleteMany\(\{ where: \{ id: evaluationId, tenantId \} \}\)/);
});

test("evaluation runner uses the production graph engine with non-writing effects", () => {
  const runner = src("src/lib/flowEvaluationRunner.ts");
  assert.match(runner, /await runFlow\(input\.flow/);
  assert.match(runner, /Saved choice .* was not offered/);
  assert.match(runner, /\[Evaluation\] Simulated AI answer/);
  assert.match(runner, /would reserve/);
  assert.match(runner, /would create/);
  assert.match(runner, /would pause bot and notify team/);
  assert.doesNotMatch(runner, /sendWhatsApp|sendDirectMessage|tgSend|prisma\./);
});

test("simulator, evaluations, and live AI preview are mutually discoverable", () => {
  const layout = src("src/app/(app)/bot-builder/[id]/layout.tsx");
  const simulator = src("src/app/(app)/bot-builder/[id]/test/page.tsx");
  const page = src("src/app/(app)/bot-builder/[id]/evaluations/page.tsx");
  assert.match(layout, /Simulator/);
  assert.match(layout, /Evaluations/);
  assert.match(simulator, /Open evaluation suite/);
  assert.match(page, /Deterministic suite/);
  assert.match(page, /Test AI answers for live production inference/);
  assert.match(page, /Current saved draft/);
  assert.match(page, /Published version/);
  assert.match(page, /Run all/);
});
