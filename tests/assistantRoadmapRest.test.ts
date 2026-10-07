import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fastPath } from "../src/lib/assistantFastPath";
import { ANSWER_RULES } from "../src/lib/crmAssistantPlan";
import { TIDY_INSTRUCTIONS } from "../src/lib/assistantMemory";

// The rest of the DAX roadmap that needed no decision: the manager check-in
// (item 10), learning from 👎 answers (item 9), one less round trip (item 4).
const code = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const ctx = { userName: "Sean Tunley", pageLead: null };
const TEAM = [{ tool: "daily_brief", args: {} }, { tool: "sales_stats", args: {} }];

test("a manager's check-in skips the research round: the team's brief and its numbers", () => {
  for (const q of ["How's my team doing?", "how is the team doing this month", "Who needs help?", "which of my reps need coaching", "Team check-in", "coach my team"]) {
    assert.deepEqual(fastPath(q, ctx), TEAM, q);
  }
  // Anything narrower or longer goes the normal way.
  assert.equal(fastPath("How's my team doing on the Jacobs deal?", ctx), null);
  assert.equal(fastPath("how is Anna doing", ctx), null);
});

test("team answers coach person by person, the advice labelled as judgement", () => {
  assert.match(ANSWER_RULES, /Asked about a team[\s\S]*person by person[\s\S]*as \\?"My read:\\?"/);
});

test("the nightly review reads this week's 👎 answers and their reasons, and only proposes", () => {
  const tidy = code("src/lib/assistantTidy.ts");
  assert.match(tidy, /where: \{ feedback: "down", feedbackAt: \{ gte: new Date\(Date\.now\(\) - 7 \* 24 \* 60 \* 60 \* 1000\) \} \}/);
  assert.match(tidy, /"Answers rated wrong this week:",\s*\.\.\.wrong\.map\(\(t\) => stripInvisible\(/, "cleaned, inside the fenced block");
  assert.match(tidy, /if \(notes\.length < 2 && turns\.length === 0 && wrong\.length === 0\) return 0;/);
  // What it learns goes the usual way: an unreviewed playbook the owner approves.
  assert.match(tidy, /applyLearn\(null, \{ playbook: block\.playbook \}\)/);
  assert.match(TIDY_INSTRUCTIONS, /Answers rated wrong[\s\S]*One bad answer alone is not a pattern/);
});

test("the ChatGPT connection check rides with the context reads, and still stops the question", () => {
  const lib = code("src/lib/crmAssistant.ts");
  assert.match(lib, /const \[connected, whereTheyAre, context, history, learnedNow, person, profileRaw, company\] = await Promise\.all\(\[\s*isCodexConnected\(\),/);
  assert.match(lib, /mark\("context"\);\s*if \(!connected\) return \{ ok: false, error: "Connect ChatGPT first/);
});
