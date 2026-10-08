import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 2026-10-02: competitor research failed every day since 26 Sep with "credit
// balance is too low" — lead research had moved to the ChatGPT subscription
// (4ff5e682) and competitor research had not. Every competitor AI call now goes
// through the same connection, with no fallback to Anthropic credit.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const lib = src("src/lib/competitors.ts");
const fn = (name: string) => lib.slice(lib.indexOf(`async function ${name}(`), lib.indexOf("\n}\n", lib.indexOf(`async function ${name}(`)));

test("research and discovery use ChatGPT first, and never reach Anthropic when it is connected", () => {
  const call = fn("callWithWebSearch");
  const codexBranch = call.slice(call.indexOf("if (await isCodexConnected())"), call.indexOf('const apiKey = await getSetting("ANTHROPIC_API_KEY")'));
  assert.ok(call.indexOf("if (await isCodexConnected())") > -1 && call.indexOf("if (await isCodexConnected())") < call.indexOf("api.anthropic.com"));
  assert.match(codexBranch, /codexRespond\(\{[\s\S]*webSearch: true,/);
  assert.match(codexBranch, /if \("error" in reply\) \{[\s\S]*return \{ error: reply\.error \};/, "a ChatGPT failure is returned, not retried on Anthropic");
  assert.doesNotMatch(codexBranch, /anthropic/i);
});

test("daily change classification uses ChatGPT too", () => {
  const classify = fn("aiClassifyChange");
  assert.ok(classify.indexOf("if (await isCodexConnected())") < classify.indexOf("api.anthropic.com"));
  assert.match(classify, /codexRespond\(\{ instructions: system, prompt: user, reasoningEffort: "low"/);
});

test("briefs record the model that wrote them and drop ChatGPT's inline links", () => {
  assert.equal(lib.match(/model: result\.model,/g)?.length, 2);
  assert.match(fn("researchCompetitor"), /const text = result\.inlineCitations \? stripInlineCitations\(result\.text\) : result\.text;/);
});

test("a failed run says why", () => {
  const actions = src("src/app/actions/competitors.ts");
  assert.match(actions, /refuse\(`AI research couldn't finish: \$\{result\.error \?\? "unknown error"\}`\)/);
  assert.match(actions, /refuse\(`AI discovery couldn't finish: \$\{result\.error \?\? "unknown error"\}`\)/);
  assert.match(fn("callWithWebSearch"), /\/credit balance\/i\.test\(detail\)/);
});
