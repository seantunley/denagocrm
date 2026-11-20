import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fitObservation, leadingSummaries, lookupFailedNote, summary } from "../src/lib/assistant/observationFit";
import { briefQuestion, briefSinceDay } from "../src/lib/proactiveRules";
import { catchUpSince } from "../src/lib/assistantCatchUp";

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

// Review of #1157: find_leads heads its list with { total, listed }, find_quotes with { matching } — counted as records,
// "showing 13" meant 12 leads and "showing 1" none. Summaries are marked where made, always kept, never counted.
test("a summary heading the list is kept whole and never counted as a record", () => {
  const leads = [summary({ total: 61, listed: 25, note: "newest first" }), ...rows(25)];
  assert.equal(leadingSummaries(leads), 1);
  assert.equal(leadingSummaries(rows(3)), 0, "unmarked look-alikes are records");
  assert.equal(leadingSummaries([{ total: 61, listed: 25 }, ...rows(2)]), 0, "only a MARKED summary counts — never guessed by shape");

  const out = JSON.parse(fitObservation(JSON.parse(JSON.stringify(leads)), true, 1_500, leadingSummaries(leads)));
  const shownLeads = out.results.slice(1);
  assert.deepEqual(out.results[0], { total: 61, listed: 25, note: "newest first" }, "the summary, whole, first");
  assert.equal(out.showing, `${shownLeads.length} of 25+`, "records only");
  assert.ok(shownLeads.every((r: { id: string }) => r.id.startsWith("lead-")));
  assert.match(out.note, /the summary before them is complete/);

  // Only the summary fits: "0 of 25" — never "showing 1".
  const tight = JSON.parse(fitObservation(leads, false, 400, 1));
  assert.equal(tight.showing, "0 of 25");
  assert.equal(tight.results.length, 1);

  const quotes = [summary({ matching: "3 quotes with a Rover XL in red" }), ...rows(30)];
  assert.match(JSON.parse(fitObservation(quotes, false, 1_200, leadingSummaries(quotes))).showing, /^\d+ of 30$/);

  // Wired: the count is read from the lookup's own objects (cleanDeep copies them), and every summary-first lookup marks it.
  assert.match(readFileSync("src/lib/assistant/context.ts", "utf8"), /fitObservation\(results, truncated, budget, leadingSummaries\(o\.output\.data\)\)/);
  for (const [file, n] of [
    ["src/lib/assistant/lookups/leads.ts", 1], ["src/lib/assistant/lookups/quotes.ts", 1], ["src/lib/assistantCustomersLookup.ts", 1],
    ["src/lib/assistantCustomFieldsLookup.ts", 1], ["src/lib/assistantFinance.ts", 1], ["src/lib/assistantInvoicesLookup.ts", 1],
    ["src/lib/assistantPartsFleetsLookup.ts", 2], ["src/lib/assistantPaymentMatch.ts", 1], ["src/lib/assistantTestDrivesLookup.ts", 1],
  ] as const) {
    assert.equal((readFileSync(file, "utf8").match(/\bsummary\(\{/g) ?? []).length, n, file);
  }
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
  assert.match(q, /Start with daily_brief and catch_up \{"since":"2026-11-18"\} together, in one step/);
  assert.match(q, /Give catch_up exactly that since date\./);
  assert.match(q, /2\. What my customers did since yesterday[^\n]*\(from catch_up\)/);
  assert.match(q, /Look closer \(lead_brief\) only at those three/);
});

// Review of #1157: catch_up's own default is "since their last question to DAX" — a question at 06:30 would leave a 07:30
// brief with an hour. The brief names the window instead, and catch_up takes it over the last question.
test("the brief's catch_up window is the previous working day, whatever the person asked earlier that morning", () => {
  assert.equal(briefSinceDay(new Date("2026-11-19T05:30:00Z")), "2026-11-18", "Thursday → Wednesday");
  assert.equal(briefSinceDay(new Date("2026-11-23T05:30:00Z")), "2026-11-20", "Monday → Friday, so the weekend is in it");
  assert.equal(briefSinceDay(new Date("2026-11-19T22:30:00Z")), "2026-11-19", "00:30 Friday in Johannesburg → Thursday");
  const now = new Date("2026-11-19T05:30:00Z");
  const askedAt0630 = new Date("2026-11-19T04:30:00Z");
  const window = catchUpSince(now, askedAt0630, briefSinceDay(now));
  assert.match(window.basis, /the start of 2026-11-18, as they asked/, "the brief's date wins over the 06:30 question");
  assert.ok(window.since.getTime() < askedAt0630.getTime());
});
