import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// Gap audit #22, survey distributions: "publish it first", "audience is empty",
// "can't be paused now" all threw, so staff saw "This page hit an error".

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const actions = src("src/app/actions/surveyDistributions.ts");

test("every distribution action returns its refusal and binds the workspace", () => {
  for (const name of ["createDistribution", "pauseDistribution", "resumeDistribution", "cancelDistribution", "retryDistributionFailures"]) {
    const at = actions.indexOf(`export async function ${name}(`);
    assert.ok(at >= 0, name);
    assert.match(actions.slice(at, at + 300), /return asActionResult\(async \(\) => \{/, name);
  }
  assert.doesNotMatch(actions, /throw new Error\(/);
  assert.doesNotMatch(actions, /\bredirect\(/, "navigate with { redirectTo }");
  assert.match(actions, /return \{ redirectTo: `\/marketing\/surveys\/distributions\/\$\{id\}`/);
});

test("the queue's audience/survey problems are refusals the person can act on", () => {
  const lib = src("src/lib/surveyDistributionQueue.ts");
  assert.match(lib, /throw new ActionRefusal\("The selected audience contains no contacts\."\)/);
  assert.match(lib, /throw new ActionRefusal\("Only an active, published survey can be sent/);
  assert.match(lib, /throw new ActionRefusal\("No contacts you can reach remain/);
});

test("both pages use SaveForm", () => {
  for (const file of ["src/app/(app)/marketing/surveys/distributions/page.tsx", "src/app/(app)/marketing/surveys/distributions/[id]/page.tsx"]) {
    assert.doesNotMatch(src(file), /<form[^>]*\baction=\{/, file);
  }
});
