import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

const code = stripComments(readFileSync(path.join(root, "src/lib/ai.ts"), "utf8"));
const research = code.slice(code.indexOf("export async function aiResearch"), code.indexOf("export async function runAutoResearch"));

/**
 * "Only if confidently identifiable" was taken out of the research system
 * prompt in August because it made giving up the compliant answer. It stayed in
 * the per-lead message for every personal-email lead, and a model that weighs
 * the latest instruction most — GPT-5.6 Terra on the ChatGPT subscription —
 * gave up on a lead the earlier Opus note had usefully listed name matches for.
 */

test("NO PART OF THE RESEARCH PROMPT OFFERS GIVING UP AS THE SAFE ANSWER", () => {
  assert.ok(
    !/only if confidently identifiable/i.test(research),
    "neither the system prompt nor the per-lead message makes bailing the compliant reply",
  );
});

test("THE PERSONAL-EMAIL LINE POINTS AT THE NAME-MATCH RULE INSTEAD", () => {
  assert.match(research, /Personal email, so there is no company domain/);
  assert.match(research, /report the best-evidenced name matches as your instructions describe/);
  // And the rule it points at is still there.
  assert.match(research, /WHEN SEVERAL PEOPLE SHARE THE NAME, REPORT THE BEST-EVIDENCED ONE/);
});
