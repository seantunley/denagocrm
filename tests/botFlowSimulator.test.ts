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
  // The trace now names the executing node as well, so these stay anchored on
  // the "would" wording that proves the simulator only describes the effect.
  assert.match(action, /CRM: node .*would create/);
  assert.match(action, /CRM: node .*would reserve slot/);
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
  assert.match(ui, /AI outcome/);
  assert.match(ui, /Times out/);
});

test("the editor can simulate the current in-memory canvas", () => {
  const builder = src("src/components/FlowBuilder.tsx");
  assert.match(builder, /currentDraftDefinition/);
  assert.match(builder, /Test current canvas/);
  assert.match(builder, /draftDefinition=\{currentDraftDefinition\}/);

  const action = src("src/app/actions/flowSimulator.ts");
  assert.match(action, /requestedDefinition \|\| row\.definition/);
  assert.match(action, /requestedDefinition\.length > 250_000/);
  assert.match(action, /const row = await prisma\.botFlow\.findFirst/, "an in-memory draft must not bypass tenant ownership");
});

test("the simulator exposes failure, availability, identity and Journey scenarios", () => {
  const action = src("src/app/actions/flowSimulator.ts");
  for (const value of ["race_lost", "unverified", "missing", "simulated CRM refusal", "simulated Journey refusal", "AI provider timeout"]) {
    assert.match(action, new RegExp(value, "i"));
  }
  const ui = src("src/components/FlowSimulator.tsx");
  for (const label of ["CRM actions", "Workshop slots", "Customer identity", "Booking lookup", "Journey enrolment"]) {
    assert.match(ui, new RegExp(label));
  }
});

test("the simulator greeting comes from the acting workspace Company Profile", () => {
  const action = src("src/app/actions/flowSimulator.ts");
  assert.match(action, /const company = await getCompanyProfile\(\)/);
  assert.match(action, /Welcome to \$\{company\.name\}/);
  assert.doesNotMatch(action, /Welcome to Denago Cape Town/);
});
