import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("flow simulator runs the real engine but imports no CRM write helpers", () => {
  const action = src("src/app/actions/flowSimulator.ts");
  assert.match(action, /runFlow\(flow, session, turn/);
  assert.doesNotMatch(action, /createIntakeLead|createLeadRecord|reserveSlot|sendWhatsApp|sendDirectMessage|tgSend|prisma\.activity\.create/);
  assert.match(action, /CRM: would create/);
  assert.match(action, /CRM: would reserve slot/);
});

test("simulated AI and handoff are explicit test effects", () => {
  const action = src("src/app/actions/flowSimulator.ts");
  assert.match(action, /simulateAiHandoff/);
  assert.match(action, /\[Simulator\] AI response/);
  assert.match(action, /Handoff: would pause bot and notify team/);
});

test("simulator page remains owner-gated and clearly draft-only", () => {
  const page = src("src/app/(app)/bot-builder/[id]/test/page.tsx");
  assert.match(page, /await requireOwner\(\)/);
  assert.match(page, /production graph engine/);
  assert.match(page, /every write\/send replaced by a simulator effect/);

  const editor = src("src/app/(app)/bot-builder/[id]/page.tsx");
  assert.match(editor, /Test saved draft/);
});

test("simulator UI exposes transcript, execution trace, variables and file input", () => {
  const ui = src("src/components/FlowSimulator.tsx");
  assert.match(ui, /Customer preview/);
  assert.match(ui, /Execution trace/);
  assert.match(ui, /Variables/);
  assert.match(ui, /sample-file\.jpg/);
  assert.match(ui, /AI hands off/);
});
