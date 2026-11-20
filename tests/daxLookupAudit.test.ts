import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fitObservation, lookupFailedNote } from "../src/lib/assistant/observationFit";
import { briefQuestion } from "../src/lib/proactiveRules";

// Sean, 2026-11-20: "fix the audit findings" (docs/dax-tools-and-learning-audit-2026-11-20.md, Part 2, gaps 1–3),
// DAX's lookups measured against Scarlet's tool rules.

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `lead-${i + 1}`, title: `Lead ${i + 1}`, detail: "x".repeat(80) }));

test("gap 2: a big result ends at whole records and says how many were left out", () => {
  const small = rows(3);
  assert.equal(fitObservation(small, false, 10_000), JSON.stringify({ truncated: false, results: small }), "fits: unchanged");

  const out = fitObservation(rows(60), false, 2_000);
  assert.ok(out.length <= 2_000);
  const parsed = JSON.parse(out) as { truncated: boolean; showing: string; note: string; results: { id: string }[] };
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.showing, `${parsed.results.length} of 60`);
  assert.match(parsed.note, /Narrow the lookup[\s\S]*never say these are all of them/);
  assert.deepEqual(parsed.results.map((r) => r.id), rows(60).slice(0, parsed.results.length).map((r) => r.id), "the first ones, in order, whole");

  assert.match(JSON.parse(fitObservation(rows(60), true, 2_000)).showing, /of 60\+$/, "the lookup itself had more: said so");
  // A single record that still doesn't fit is cut as before, rather than nothing shown.
  assert.match(fitObservation([{ body: "y".repeat(5_000) }], false, 1_000), /…\(cut\)$/);
  assert.match(readFileSync("src/lib/assistant/context.ts", "utf8"), /const body = fitObservation\(results, truncated, budget\);/);
});

test("gap 1: a failed lookup says which one, what kind of failure, and what to do", () => {
  const timeout = new Error("t");
  timeout.name = "TimeoutError";
  assert.match(lookupFailedNote("find_quotes", timeout).note, /^The find_quotes lookup timed out\. Try it once more with narrower filters/);
  assert.match(lookupFailedNote("lead_brief", new TypeError("x")).note, /^The lead_brief lookup failed[\s\S]*Don't retry it; answer from the other lookups and say what couldn't be checked\./);
  const lib = readFileSync("src/lib/crmAssistant.ts", "utf8");
  assert.match(lib, /data: \[lookupFailedNote\(s\.tool, error\)\]/);
  assert.doesNotMatch(lib, /That lookup failed — say so if it matters/);
});

test("gap 3: the morning brief starts from daily_brief and catch_up together, and looks closer at three deals at most", () => {
  const q = briefQuestion(new Date("2026-11-19T05:30:00Z"), []);
  assert.match(q, /Start with daily_brief and catch_up together, in one step/);
  assert.match(q, /2\. What my customers did since yesterday[^\n]*\(from catch_up\)/);
  assert.match(q, /Look closer \(lead_brief\) only at those three/);
});
