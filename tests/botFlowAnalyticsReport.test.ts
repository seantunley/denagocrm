import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("historic node labels come from immutable published definitions, not the mutable draft", () => {
  const code = src("src/lib/botFlowAnalyticsReport.ts");
  assert.match(code, /FROM "BotFlowVersion"/);
  assert.match(code, /SELECT "id", "version", "publishedAt", "definition"/);
  assert.doesNotMatch(code, /botFlow\.findUnique[\s\S]+definition/);
  assert.match(code, /The mutable draft is not[\s\S]+used to label historic nodes/);
});

test("analytics reporting uses explicit tenant predicates for bypassed raw reads", () => {
  const code = src("src/lib/botFlowAnalyticsReport.ts");
  assert.match(code, /const tenantId = writeTenantId\(\) \?\? DEFAULT_TENANT_ID/);
  assert.ok((code.match(/"tenantId" = \$\{tenantId\}/g) ?? []).length >= 2);
  assert.match(code, /"flowId" = \$\{flowId\}/);
});

test("drop-off is only calculated for deterministic waiting-node interactions", () => {
  const code = src("src/lib/botFlowAnalyticsReport.ts");
  assert.match(code, /node\?\.type === "choice" \|\| node\?\.type === "capture" \|\| node\?\.type === "captureFile" \|\| node\?\.type === "slots"/);
  assert.match(code, /dropOff: interactive \? Math\.max\(reached - \(interacted \?\? 0\), 0\) : null/);
  assert.match(code, /progressionRate: interactive && reached > 0/);
});

test("report surface is explicit about the current stateful-flow analytics scope", () => {
  const page = src("src/app/(app)/bot-analytics/page.tsx");
  assert.match(page, /Latest-version funnel/);
  assert.match(page, /Reach is unique customer conversations/);
  assert.match(page, /one-shot graph made entirely of automatic nodes/);
  assert.match(page, /stateful guided flows/);
});

test("report includes channel, completion, handoff and node funnel views", () => {
  const page = src("src/app/(app)/bot-analytics/page.tsx");
  assert.match(page, /All published versions · by channel/);
  assert.match(page, /Completed/);
  assert.match(page, /Handed off/);
  assert.match(page, /Progressed/);
  assert.match(page, /Drop-off/);
});
