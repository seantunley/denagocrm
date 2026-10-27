import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import Module from "node:module";
import {
  DEPTH_BUDGETS,
  HARD_DEADLINE_MS,
  MIN_CALL_MS,
  deepen,
  parseLedger,
  researchLeftMs,
  roundFits,
  startingDepth,
  type Depth,
} from "../src/lib/assistantDepth";
import { LEDGER_RULE, isComplexQuestion, isSmallTalk, parseSteps, planInstructions } from "../src/lib/crmAssistantPlan";
import { fastPath } from "../src/lib/assistantFastPath";

// assistantRun reaches server-only; its pure helpers load with it stubbed.
type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleWithLoad = Module as unknown as { _load: Loader };
const realLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request, parent, isMain) {
  if (request === "server-only") return {};
  return realLoad.call(this, request, parent, isMain);
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { mediansByDepth } = require("../src/lib/assistantRun") as typeof import("../src/lib/assistantRun");

const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/* ── The ledger: read when it's there, ignored when it isn't ─────────────── */

test("a ledger gives its depth and whether another lookup would help", () => {
  const reply = '{"tool":"find_leads","args":{"minValue":300000},"ledger":{"need":"which big deals are weak","have":"nothing yet","unsure":"close dates","more":true,"depth":"investigate"}}';
  assert.deepEqual(parseLedger(reply), { depth: "investigate", more: true });
  assert.deepEqual(parseLedger('{"tool":"done","ledger":{"more":false,"depth":"quick"}}'), { depth: "quick", more: false });
  // Depth beside the ledger instead of in it, and a code fence around it — both tolerated.
  assert.deepEqual(parseLedger('```json\n{"tool":"done","depth":"investigate","ledger":{"more":false}}\n```'), { depth: "investigate", more: false });
});

test("a missing or malformed ledger is null — the keywords decide, as before", () => {
  assert.equal(parseLedger('{"tool":"find_leads","args":{}}'), null, "no ledger");
  assert.equal(parseLedger("I think we should look at the leads."), null, "prose");
  assert.equal(parseLedger('{"tool":"done","ledger":"investigate"}'), null, "a string, not an object");
  assert.equal(parseLedger('{"tool":"done","ledger":[true]}'), null, "an array");
  assert.equal(parseLedger('{"tool":"done","ledger":{"need":"x"}}'), null, "nothing usable in it");
  assert.equal(parseLedger('{"tool":"done","ledger":{"depth":"deep","more":"yes"}}'), null, "wrong values");
  assert.deepEqual(parseLedger('{"tool":"done","ledger":{"depth":"deep","more":false}}'), { depth: null, more: false }, "the usable half survives");
  assert.equal(parseLedger('{"tool":"done","ledger":{'), null, "broken JSON");
});

test("the ledger never stops a lookup from parsing — single, batch, and the strict web step", () => {
  const ledger = '"ledger":{"more":false,"depth":"quick"}';
  assert.deepEqual(parseSteps(`{"tool":"lead_brief","args":{"lead":"Anna"},"then":"answer",${ledger}}`), [{ tool: "lead_brief", args: { lead: "Anna" } }]);
  assert.deepEqual(parseSteps(`{"tool":"web",${ledger},"depth":"quick"}`), [{ tool: "web" }]);
  assert.equal(parseSteps(`{"lookups":[{"tool":"pipeline_summary"},{"tool":"sales_stats"}],${ledger}}`)?.length, 2);
});

test("the research step is told about the ledger, and its own example parses as quick and finished", () => {
  const prompt = planInstructions({ today: "2026-10-27", userName: "Sean", stages: [], staff: [], activityTypes: [] });
  assert.ok(prompt.includes(LEDGER_RULE));
  // In the fixed part, before what varies by day and person, so the prompt cache still serves it.
  assert.ok(prompt.indexOf(LEDGER_RULE) < prompt.indexOf("Today is"));
  const example = LEDGER_RULE.slice(LEDGER_RULE.lastIndexOf('{"tool"'), -1);
  assert.deepEqual(parseSteps(example), [{ tool: "find_leads", args: { assignedTo: "Donovan" } }]);
  assert.deepEqual(parseLedger(example), { depth: "quick", more: false });
});

/* ── The floor: keywords set it; the ledger can only deepen ──────────────── */

test("a question the keywords call complex is never treated as quick", () => {
  const complex = "Why is the Jacobs deal stuck and what should we do?";
  assert.ok(isComplexQuestion(complex));
  const start = startingDepth(complex, true);
  assert.equal(start, "investigate");
  assert.equal(deepen(start, { depth: "quick", more: false }), "investigate", "the ledger saying quick doesn't lower it");
  assert.equal(deepen(start, null), "investigate");
});

test("the ledger can deepen a plain question; without it the plain question stays quick", () => {
  const plain = "Which of our open deals over R300k are least likely to close this month?";
  assert.equal(isComplexQuestion(plain), false);
  assert.equal(startingDepth(plain, true), "quick");
  assert.equal(deepen("quick", null), "quick");
  assert.equal(deepen("quick", { depth: null, more: true }), "quick");
  assert.equal(deepen("quick", { depth: "investigate", more: true }), "investigate");
  // Once deep, it stays deep for the rest of the question.
  let d: Depth = "quick";
  for (const l of [{ depth: "investigate" as const, more: true }, { depth: "quick" as const, more: true }, null]) d = deepen(d, l);
  assert.equal(d, "investigate");
});

/* ── Budgets per depth ───────────────────────────────────────────────────── */

test("quick is exactly today's ordinary budget; investigate is deeper in every way", () => {
  assert.deepEqual(DEPTH_BUDGETS.quick, { maxSteps: 3, maxLookups: 6, researchMs: 90_000, answerReserveMs: 70_000, answerMaxMs: 60_000, planEffort: "low", answerEffort: "low" });
  const i = DEPTH_BUDGETS.investigate;
  assert.equal(i.maxSteps, 8);
  assert.equal(i.maxLookups, 10);
  assert.equal(i.planEffort, "medium");
  assert.equal(i.answerEffort, "medium");
  assert.ok(i.researchMs > DEPTH_BUDGETS.quick.researchMs);
  assert.ok(i.answerMaxMs >= DEPTH_BUDGETS.quick.answerMaxMs);
});

/* ── The 280 s hard deadline ─────────────────────────────────────────────── */

test("at every depth, research plus the longest answer fits inside the hard deadline", () => {
  for (const depth of ["quick", "investigate"] as const) {
    const b = DEPTH_BUDGETS[depth];
    const researchEnds = researchLeftMs(depth, 0);
    assert.ok(b.answerMaxMs <= b.answerReserveMs, `${depth}: the answer fits its reserve`);
    assert.ok(researchEnds + b.answerMaxMs <= HARD_DEADLINE_MS, `${depth}: ${researchEnds} + ${b.answerMaxMs} ≤ ${HARD_DEADLINE_MS}`);
  }
  assert.equal(researchLeftMs("investigate", 195_000), 0);
  assert.ok(researchLeftMs("quick", 100_000) < 0, "quick stops at 90 s, as before");
});

test("a round starts only if one as slow as the slowest so far still fits", () => {
  assert.equal(roundFits(60_000, 0), true);
  assert.equal(roundFits(MIN_CALL_MS - 1, 0), false, "too little for any call");
  assert.equal(roundFits(20_000, 25_000), false, "the last round took 25 s; 20 s is not enough");
  assert.equal(roundFits(25_000, 25_000), true);
});

test("an investigation of slow rounds stops before the deadline, never at the round count alone", () => {
  // Simulate the loop: 40 s rounds (medium-effort plan + lookups), as many as the clock allows.
  for (const roundMs of [5_000, 18_000, 40_000, 70_000]) {
    let clock = 10_000; // context loading
    let slowest = 0;
    let rounds = 0;
    for (let step = 0; step < DEPTH_BUDGETS.investigate.maxSteps; step++) {
      if (!roundFits(researchLeftMs("investigate", clock), slowest)) break;
      clock += roundMs;
      slowest = Math.max(slowest, roundMs);
      rounds++;
    }
    assert.ok(rounds >= 1, `${roundMs}: at least one round`);
    // Research never runs past its end (195 s), so the answer always gets its full time before 280 s.
    assert.ok(clock <= 195_000, `${roundMs} ms rounds: research ran to ${clock} ms`);
    assert.ok(HARD_DEADLINE_MS - clock >= DEPTH_BUDGETS.investigate.answerMaxMs, `${roundMs} ms rounds: the answer has its 80 s`);
    if (roundMs <= 18_000) assert.ok(rounds > DEPTH_BUDGETS.quick.maxSteps, "fast rounds get more than quick's three");
  }
});

/* ── The fast path and small talk are unchanged ──────────────────────────── */

test("the fast path and small talk skip research and stay quick, whatever the keywords say", () => {
  assert.ok(fastPath("what needs my attention", { userName: "Sean", pageLead: null }));
  assert.ok(isSmallTalk("thanks"));
  // A question that skips research is quick even if it carries a complex keyword.
  assert.equal(startingDepth("why not", false), "quick");
  assert.equal(startingDepth("what needs my attention", false), "quick");
});

test("in askCrm, depth is set only after research is decided, and the answer uses that depth's effort", () => {
  const lib = code("src/lib/crmAssistant.ts");
  const loop = lib.slice(lib.indexOf("let depth: Depth"), lib.indexOf("const rows = dedupeRows(observations.flatMap((o) => o.output.rows));\n  const tools"));
  assert.match(loop, /let depth: Depth = "quick";/);
  // Research is decided exactly as before (small talk, image, fast path) — then the depth.
  const research = loop.indexOf("const research = !(isSmallTalk(question) && !images.length) && !fast;");
  const start = loop.indexOf("depth = startingDepth(question, research);");
  assert.ok(research > 0 && start > research, "depth follows the unchanged research decision");
  assert.match(loop, /if \(fast\) await runLookups\(fast, 1\);/);
  // Planning and answering both read the current depth's budget.
  assert.match(loop, /reasoningEffort: budget\(\)\.planEffort/);
  assert.match(loop, /reasoningEffort: budget\(\)\.answerEffort,/);
  assert.match(loop, /timeoutMs: Math\.min\(budget\(\)\.answerMaxMs, Math\.max\(MIN_CALL_MS, HARD_DEADLINE_MS - elapsed\(\)\)\)/);
  // The ledger can deepen and can stop the loop, but the gate's "continue" (required evidence missing) still wins.
  assert.match(loop, /depth = deepen\(depth, ledger\);/);
  assert.match(loop, /const enough = planSaysAnswerNext\(reply\.text\) \|\| ledger\?\.more === false;/);
  assert.ok(loop.indexOf('if (gate === "continue") continue;') < loop.indexOf('if (gate === "answer" || enough) break;'));
});

/* ── Logging: numbers on the run, never the ledger's words ───────────────── */

test("the run records the depth and the ledger's yes/no as numbers; the ledger's words are never logged", () => {
  const lib = code("src/lib/crmAssistant.ts");
  assert.match(lib, /timings\.depth = depth === "investigate" \? 1 : 0;/);
  assert.match(lib, /if \(moreHelps !== null\) timings\.moreLookupsHelp = moreHelps \? 1 : 0;/);
  assert.doesNotMatch(lib, /logError\([^)]*ledger/);
});

test("the speed view times quick questions and investigations apart; older runs count in neither", () => {
  const split = mediansByDepth([
    { depth: 0, total: 8_000 },
    { depth: 0, total: 12_000 },
    { depth: 1, total: 60_000 },
    { total: 99_000 },
    null,
  ]);
  assert.equal(split.quick.total, 10_000);
  assert.equal(split.investigate.total, 60_000);
});
