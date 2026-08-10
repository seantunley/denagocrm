import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("version history reads immutable snapshots with explicit tenant + flow predicates", () => {
  const page = src("src/app/(app)/bot-builder/[id]/versions/page.tsx");
  assert.match(page, /FROM "BotFlowVersion"/);
  assert.match(page, /"tenantId" = \$\{tenantId\}/);
  assert.match(page, /"flowId" = \$\{flow\.id\}/);
  assert.match(page, /ORDER BY "version" DESC/);
});

test("restore copies a version into the draft and never publishes directly", () => {
  const action = src("src/app/actions/flowVersions.ts");
  assert.match(action, /data: \{ definition: version\.definition \}/);
  assert.doesNotMatch(action, /publishFlowSnapshot|setActiveFlow|active: true/);
  assert.match(action, /live publication was unchanged/);
});

test("restore is tenant-bound to the selected flow and version", () => {
  const action = src("src/app/actions/flowVersions.ts");
  assert.match(action, /"tenantId" = \$\{tenantId\}/);
  assert.match(action, /"flowId" = \$\{flowId\}/);
  assert.match(action, /"id" = \$\{versionId\}/);
});

test("rollback cannot overwrite a newer canvas save", () => {
  const action = src("src/app/actions/flowVersions.ts");
  assert.match(action, /expectedUpdatedAt/);
  assert.match(action, /where: \{ id: flowId, updatedAt: expectedUpdatedAt, \.\.\.scope \}/);
  assert.match(action, /if \(updated\.count !== 1\) return/);
});

test("version workspace explains pinned-session and republish behaviour", () => {
  const page = src("src/app/(app)/bot-builder/[id]/versions/page.tsx");
  assert.match(page, /copy into draft/);
  assert.match(page, /normal Publish action/);
  assert.match(page, /creates a new immutable version/);
  assert.match(page, /Existing conversations stay pinned/);
});
