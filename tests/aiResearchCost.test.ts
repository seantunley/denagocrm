import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

/**
 * Automatic lead research was the most expensive thing this app did, and it did
 * it on a loop. Every new lead got an Opus 5 call with up to eight web searches
 * (~144k input tokens a call, per the app's own ledger), a lead whose research
 * came back empty was retried on every cron run for 48 hours, and an account
 * out of credit produced several hundred failed calls a day.
 */

const code = stripComments(src("src/lib/ai.ts"));
const sweep = code.slice(code.indexOf("export async function runAutoResearch"));

test("A LEAD GETS ONE AUTOMATIC ATTEMPT, NOT ONE PER CRON RUN", () => {
  assert.match(sweep, /researchedAt: null,/, "the sweep selects only leads never attempted");
  assert.match(
    sweep,
    /await prisma\.lead\.update\(\{ where: \{ id: lead\.id \}, data: \{ researchedAt: new Date\(\) \} \}\)/,
    "a failed attempt still stamps the lead, so the next run does not pay for it again",
  );
});

test("AN OUT-OF-CREDIT API STOPS THE SWEEP INSTEAD OF WORKING DOWN THE LIST", () => {
  assert.match(sweep, /if \(result\.transient\) break;/, "a transient failure ends the run");

  // The break must come BEFORE the lead is stamped: an out-of-credit call did
  // not research anything, so the lead must not lose its turn.
  const breakAt = sweep.indexOf("if (result.transient) break;");
  const stampAt = sweep.indexOf("data: { researchedAt: new Date() }");
  assert.ok(breakAt > 0 && stampAt > breakAt, "transient failures leave the lead unmarked");

  // Credit exhaustion is a 400, not a 402, so the body has to be read.
  assert.match(code, /\/credit balance\/i\.test\(text\)/, "credit exhaustion is recognised as transient");
  assert.match(code, /res\.status === 429 \|\| res\.status >= 500/, "rate limits and outages are transient too");
});

test("LOST LEADS ARE NOT RESEARCHED", () => {
  assert.match(sweep, /status: \{ not: "lost" \}/, "the spam a rep has already binned costs nothing");
});

test("THE SWEEP USES THE CHEAP MODEL; THE BUTTON KEEPS THE DEEP ONE", () => {
  assert.match(code, /export const AUTO_RESEARCH_MODEL = "claude-haiku-4-5";/);
  assert.match(code, /export const AUTO_RESEARCH_MAX_SEARCHES = 3;/);
  assert.match(
    sweep,
    /\{ model: AUTO_RESEARCH_MODEL, maxSearches: AUTO_RESEARCH_MAX_SEARCHES \}/,
    "the automatic sweep asks for the cheap tier",
  );

  // The default a caller gets without options is still the deep research —
  // somebody pressing Research on a lead asked for it.
  assert.match(code, /model: options\.model \?\? "claude-opus-5"/);
  assert.match(code, /max_uses: options\.maxSearches \?\? 8/);

  const manual = stripComments(src("src/app/actions/ai.ts"));
  assert.match(manual, /aiResearch\(\{ name, email \}\)/, "the Research button passes no options");
  assert.ok(!/AUTO_RESEARCH_MODEL/.test(manual), "and does not borrow the sweep's cheap tier");
});

test("THE SWEEP IS STILL CAPPED PER RUN", () => {
  assert.match(sweep, /take: 5,/);
});
