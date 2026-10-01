import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// Gap audit #22, journeys. Saving and publishing are deliberately STRICT — "two
// triggers share an ID", "a journey needs at least one enrolment trigger", "this
// enrols on a stage that no longer exists" — and every one of those messages,
// written for the person building the journey, reached them as "This page hit an
// error". Archive was also a single click.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const actions = src("src/app/actions/journeys.ts");

test("every journey action a person triggers returns its refusal", () => {
  for (const name of ["createJourney", "saveJourneyDraft", "publishJourney", "setJourneyStatus", "installJourneyTemplates"]) {
    const at = actions.indexOf(`export async function ${name}(`);
    assert.ok(at >= 0, name);
    assert.match(actions.slice(at, at + 300), /return asActionResult\(async \(\) => \{/, name);
  }
  assert.doesNotMatch(actions, /throw new Error\(/);
  assert.doesNotMatch(actions, /findUniqueOrThrow\(/);
});

test("the strict parsers' own messages are shown, on save AND publish", () => {
  assert.match(actions, /const triggers = strict\(\(\) => parseJourneyTriggers\(rawTriggers\)\);/);
  assert.match(actions, /strict\(\(\) => parseConditionGroup\(rawConditions\)\)/);
  assert.match(actions, /strict\(\(\) => parseJourneyDefinition\(rawDefinition\)\)/);
  assert.match(actions, /strict\(\(\) => parseJourneyTriggers\(draft\.triggers\)\);/);
  assert.match(actions, /strict\(\(\) => parseJourneyDefinition\(draft\.definition\)\);/);
  // Only Errors become refusals — the helper doesn't swallow or rewrite anything else.
  assert.match(actions, /if \(error instanceof ActionRefusal\) throw error;\s*refuse\(error instanceof Error && error\.message \? error\.message :/);
});

test("the builder and the library show them; archive is confirmed and its reason audited", () => {
  const builder = src("src/components/JourneyBuilder.tsx");
  assert.match(builder, /<SaveForm action=\{submitAction \?\? createJourney\} resetOnSuccess=\{false\}/);
  const page = src("src/app/(app)/journeys/page.tsx");
  for (const action of ["installJourneyTemplates", "publishJourney", "setJourneyStatus"]) {
    assert.doesNotMatch(page, new RegExp(`<form action=\\{${action}`), action);
  }
  assert.match(page, /<ConfirmDelete\s+action=\{setJourneyStatus\.bind\(null, journey\.id, "archived"\)\}/);
  assert.match(actions, /journey “\$\{journey\.name\}”\$\{reason \? ` — \$\{reason\}` : ""\}`/);
});
