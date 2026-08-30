import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("AI flow generation is a draft-only pure generator with a strict JSON contract", () => {
  const code = src("src/lib/flowAiDraft.ts");
  assert.match(code, /Return exactly one JSON object and nothing else/);
  assert.match(code, /JSON\.parse\(text\.trim\(\)\)/);
  assert.match(code, /validateFlow\(flow, input\.channels\)/);
  assert.doesNotMatch(code, /publishFlowSnapshot|setActiveFlow|active: true/);
  assert.doesNotMatch(code, /prisma\./, "the model-generation helper must not write the database");
});

test("only compiler-clean generated graphs may become signed proposals", () => {
  const action = src("src/app/actions/flowAi.ts");
  assert.match(action, /const errors = flowErrors\(generated\.issues\)/);
  const errorsAt = action.indexOf("const errors = flowErrors");
  const proposalAt = action.indexOf("signFlowProposal", errorsAt);
  assert.ok(errorsAt >= 0 && proposalAt > errorsAt);
  assert.match(action, /if \(errors\.length\)/);
  const generate = action.slice(action.indexOf("export async function generateFlowDraftAction"), action.indexOf("export async function applyFlowDraftProposalAction"));
  assert.doesNotMatch(generate, /botFlow\.updateMany/, "generation must not write the draft");
  assert.doesNotMatch(action, /publishFlowSnapshot|setActiveFlow/);
});

test("applying an AI proposal cannot overwrite a human save that lands concurrently", () => {
  const action = src("src/app/actions/flowAi.ts");
  assert.match(action, /flowDefinitionHash\(row\.definition\) !== proposal\.baseHash/);
  assert.match(action, /where: \{ id: flowId, definition: row\.definition, \.\.\.scope \}/);
  assert.match(action, /if \(updated\.count !== 1\)/);
  assert.match(action, /Nothing was overwritten/);
});

test("generated graphs are fenced to existing deterministic node capabilities", () => {
  const code = src("src/lib/flowAiDraft.ts");
  assert.match(code, /Use only the allowed node types\/actions/);
  // The fence has since grown to bar wait nodes and to name Journey enrolment as
  // the one extra CRM write path, so both rules are matched around those additions.
  assert.match(code, /Do not invent email\/SMS\/webhook\/code(\/wait)? nodes/);
  assert.match(code, /CRM writes happen only through booking\(service\|demo\|lead\|cancel\), slots\(book\|reschedule\)(, and explicit journey enrolment)?\. booking\(lookup\) is read-only/);
  assert.match(code, /Use handoff when the requested action is unsupported/);
});

test("the editor makes generation, review and apply separate decisions", () => {
  const ui = src("src/components/FlowAiDraftForm.tsx");
  assert.match(ui, /does <b>not<\/b> change the draft/);
  assert.match(ui, /Review AI proposal/);
  assert.match(ui, /Apply proposal/);
  assert.match(ui, /Reject/);
  assert.match(ui, /Publishing remains separate/);
  assert.match(src("src/app/(app)/bot-builder/[id]/page.tsx"), /<FlowAiDraftForm flowId=\{row\.id\} \/>/);
});

test("proposal application revalidates the graph and external references", () => {
  const action = src("src/app/actions/flowAi.ts");
  assert.match(action, /verifyFlowProposal\(token\)/);
  assert.match(action, /validateFlowForEnabledChannels\(flow\)/);
  assert.match(action, /proposal\.ownerId !== owner\.id/);
  assert.match(action, /invalid or expired/);
});

test("the AI node contract includes every fallible outcome route", () => {
  const generator = src("src/lib/flowAiDraft.ts");
  for (const field of ["failureText", "failureNext", "unavailableNext", "booking_identity"]) assert.match(generator, new RegExp(field));
  assert.match(generator, /Every fallible booking, slots or journey action needs an honest failure route/);
});
