import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// Gap audit #22, campaign review: "you submitted it, so you can't approve it",
// "no eligible recipients", "schedule must be in the future", QA failures — all
// threw, so the reviewer saw "This page hit an error" instead of the reason.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const actions = src("src/app/actions/marketingCampaignWorkflow.ts");

test("every campaign workflow action returns its refusal", () => {
  const names = [...actions.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]);
  assert.equal(names.length, 6);
  for (const name of names) {
    const at = actions.indexOf(`export async function ${name}(`);
    assert.match(actions.slice(at, at + 200), /return asActionResult\(async \(\) => \{/, name);
  }
  assert.doesNotMatch(actions, /throw new Error\(/);
});

test("the workflow library's reasons are refusals, not crashes", () => {
  const lib = src("src/lib/marketingCampaignWorkflow.ts");
  assert.doesNotMatch(lib, /throw new Error\(/);
  assert.match(lib, /throw new ActionRefusal\("The person who submitted a campaign cannot approve it"\)/);
  assert.match(lib, /throw new ActionRefusal\("No eligible recipients match this audience"\)/);
});

test("the review page shows them", () => {
  assert.doesNotMatch(src("src/app/(app)/marketing/campaigns/[id]/review/page.tsx"), /<form[^>]*\baction=\{/);
});
