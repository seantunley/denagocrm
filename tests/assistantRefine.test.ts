import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { parseSteps, planInstructions, planSaysAnswerNext } from "../src/lib/crmAssistantPlan";

const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/*
 * From the 25-question eval on dev (2026-10-05): the research step kept
 * WRITING THE ANSWER in prose instead of choosing a lookup — wasting a round on
 * nearly every question, failing a follow-up outright, and never looking up the
 * customer for "remind me to call Tanya".
 */

const ctx = { today: "2026-10-05", userName: "Sean", stages: ["New", "Contacted"], staff: ["Donovan"], activityTypes: ["call"] };

test('"then":"answer" goes straight to the answer — no round spent saying done', () => {
  assert.equal(planSaysAnswerNext('{"tool":"lead_brief","args":{"lead":"Anna"},"then":"answer"}'), true);
  assert.equal(planSaysAnswerNext('{"lookups":[{"tool":"pipeline_summary"}],"then":"answer"}'), true);
  assert.equal(planSaysAnswerNext('{"tool":"lead_brief","args":{"lead":"Anna"}}'), false);
  assert.equal(planSaysAnswerNext("Six of those leads are still in New."), false);
  // "then" is the loop's instruction, never part of the lookup — even on the strict web step.
  assert.deepEqual(parseSteps('{"tool":"lead_brief","args":{"lead":"Anna"},"then":"answer"}'), [{ tool: "lead_brief", args: { lead: "Anna" } }]);
  assert.deepEqual(parseSteps('{"tool":"web","then":"answer"}'), [{ tool: "web" }]);
  assert.equal(parseSteps('{"tool":"web","query":"x","then":"answer"}'), null, "the web step still refuses arguments");
  const loop = code("src/lib/crmAssistant.ts");
  assert.match(loop, /if \(planSaysAnswerNext\(reply\.text\)\) break;/);
});

test("prose instead of a choice gets ONE firm retry on the first step, and is never a dead end", () => {
  const lib = code("src/lib/crmAssistant.ts");
  assert.match(lib, /!parseSteps\(reply\.text\) && step === 0\) \{[\s\S]*?reply = await plan\(step, true\);/);
  // …through the one plan call, which builds the firm prompt when asked to insist.
  assert.match(lib, /const plan = \(step: number, insist: boolean\) =>\s*withRetry\(breakerKey, \(\) =>\s*codexRespond\(\{ instructions, prompt: planPrompt\(step, insist\)/);
  assert.match(lib, /export const PLAN_INSIST =\s*'Your last reply was prose\. Reply with ONE JSON object only/);
  assert.doesNotMatch(lib, /I couldn't work out what to look up/, "no more failing the question");
});

test("the research step is told it never writes the answer, that tasks need the lead first, and to look again for follow-ups", () => {
  const prompt = planInstructions(ctx);
  assert.match(prompt, /YOU NEVER WRITE THE ANSWER/);
  assert.match(prompt, /look that lead up FIRST \(lead_brief\) — never say done without it/);
  assert.match(prompt, /A follow-up \("and which of those…", "what about Donovan's\?"\) is a NEW lookup/);
  assert.match(prompt, /earlier turns are context, not today's data/);
  assert.match(prompt, /With NO stage it returns every stage at once/, "deliveries in one lookup, not five");
});

test("quick-reply buttons must tell the options apart; the answer step runs at low effort", () => {
  assert.match(code("src/lib/assistantActions.ts"), /never \\"The first one\\"/);
  const lib = code("src/lib/crmAssistant.ts");
  const answer = lib.slice(lib.indexOf("const answerReply = await withRetry(breakerKey, () => codexRespond("));
  assert.match(answer.slice(0, 2500), /reasoningEffort: "low",/);
});

