import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { fastPath, pageLeadFromHint } from "../src/lib/assistantFastPath";
import { BREAKER_FAILURES, BREAKER_OPEN_MS, breakerOpen, recordFailure, resetBreaker, retryable, withRetry } from "../src/lib/assistantBreaker";

type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleWithLoad = Module as unknown as { _load: Loader };
const realLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request, parent, isMain) {
  if (request === "server-only") return {};
  return realLoad.call(this, request, parent, isMain);
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runView, medianTimings, RUN_LOST, RUN_STALE_MS } = require("../src/lib/assistantRun") as typeof import("../src/lib/assistantRun");

const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const LEAD = "cmabcdefghijklmnopqrstuv";
const ctx = { userName: "Sean Tunley", pageLead: null };

/* ── Fast path: no research round for the obvious questions ──────────────── */

test("the obvious questions go straight to their lookup", () => {
  assert.deepEqual(fastPath("What needs my attention today?", ctx), [{ tool: "daily_brief", args: {} }]);
  assert.deepEqual(fastPath("plan my day", ctx), [{ tool: "daily_brief", args: {} }]);
  assert.deepEqual(fastPath("What's overdue for me?", ctx), [{ tool: "find_activities", args: { when: "overdue", assignedTo: "Sean Tunley" } }]);
  assert.deepEqual(fastPath("what's overdue", ctx), [{ tool: "find_activities", args: { when: "overdue" } }], "not 'mine' unless said");
  assert.deepEqual(fastPath("What do I have on today?", ctx), [{ tool: "find_activities", args: { when: "today", assignedTo: "Sean Tunley" } }]);
  assert.deepEqual(fastPath("How many open leads do I have?", ctx), [{ tool: "pipeline_summary", args: {} }]);
  assert.deepEqual(fastPath("Quotes waiting for a signature", ctx), [{ tool: "find_quotes", args: { awaitingSignature: true } }]);
  assert.deepEqual(fastPath("What should I do with this one?", { ...ctx, pageLead: LEAD }), [{ tool: "lead_brief", args: { lead: LEAD } }]);
});

test("anything less certain goes the normal way", () => {
  for (const q of [
    "What should I do with this one?", // no record on the page
    "What's overdue for Donovan?", // names someone
    "What needs my attention and draft a message to Anna", // a second clause
    "How many open leads did Kristina have last month?",
    "Which quotes are waiting for a signature from Lisa?",
    "Has Lisa signed?",
    "",
  ]) {
    assert.equal(fastPath(q, ctx), null, q);
  }
});

test("'this one' comes from the page hint, whichever page it is", () => {
  assert.equal(pageLeadFromHint(`The person is looking at lead id ${LEAD} — "this" … (use lead_brief with that id).`), LEAD);
  assert.equal(pageLeadFromHint(`… quote Q-1042 — "this" means it (use lead_brief with "${LEAD}").`), LEAD);
  assert.equal(pageLeadFromHint("The person is on the leads board"), null);
});

test("a fast-path question skips the research round but is still written up by DAX", () => {
  const lib = code("src/lib/crmAssistant.ts");
  assert.match(lib, /const fast = images\.length \? null : fastPath\(question, \{ userName: user\.name \|\| "", pageLead: pageLeadFromHint\(whereTheyAre\) \}\);/);
  assert.match(lib, /const research = !\(isSmallTalk\(question\) && !images\.length\) && !fast;\s*if \(fast\) await runLookups\(fast, 1\);/);
});

/* ── Retry once, and the breaker ─────────────────────────────────────────── */

beforeEach(() => resetBreaker());

test("a passing ChatGPT fault is retried once — never the usage limit, never a refusal", async () => {
  assert.equal(retryable({ error: "ChatGPT is unavailable or over its usage limit (503).", transient: true }), true);
  assert.equal(retryable({ error: "Could not reach ChatGPT.", transient: true }), true);
  assert.equal(retryable({ error: "ChatGPT is unavailable or over its usage limit (429).", transient: true }), false);
  assert.equal(retryable({ error: "ChatGPT refused the request (400)." }), false);
  let calls = 0;
  const flaky = await withRetry("t1", async () => (++calls === 1 ? { error: "x (502)", transient: true } : { text: "ok" }), async () => {});
  assert.deepEqual(flaky, { text: "ok" });
  assert.equal(calls, 2);
  calls = 0;
  await withRetry("t1", async () => (++calls, { error: "x (429)", transient: true }), async () => {});
  assert.equal(calls, 1, "the usage limit isn't hammered");
});

test("the breaker opens after repeated outages, only for that workspace, and a success closes it", async () => {
  const now = 1_000_000;
  for (let i = 0; i < BREAKER_FAILURES; i++) recordFailure("tenant_a", now + i);
  assert.equal(breakerOpen("tenant_a", now + 10), true);
  assert.equal(breakerOpen("tenant_b", now + 10), false);
  assert.equal(breakerOpen("tenant_a", now + BREAKER_OPEN_MS + 10), false, "it closes on its own");
  for (let i = 0; i < BREAKER_FAILURES; i++) recordFailure("tenant_a", now + i);
  await withRetry("tenant_a", async () => ({ text: "fine" }), async () => {});
  assert.equal(breakerOpen("tenant_a", now + 10), false, "one success closes it");
  // A refusal is a setting to fix, not an outage.
  for (let i = 0; i < 5; i++) await withRetry("tenant_c", async () => ({ error: "ChatGPT refused the request (400)." }), async () => {});
  assert.equal(breakerOpen("tenant_c"), false);
});

test("with the breaker open, DAX answers from the CRM where it can, else says so at once", () => {
  const lib = code("src/lib/crmAssistant.ts");
  assert.match(lib, /if \(breakerOpen\(breakerKey\)\) \{\s*if \(!fast\) return \{ ok: false, error: DEGRADED_ERROR \};\s*await runLookups\(fast, 1\);/);
  assert.match(lib, /return \{ ok: true, answer: DEGRADED_NOTE, rows,/);
  // Both model calls go through the retry/breaker.
  assert.match(lib, /withRetry\(breakerKey, \(\) =>\s*codexRespond\(\{ instructions, prompt: planPrompt/);
  assert.match(lib, /const answerReply = await withRetry\(breakerKey, \(\) => codexRespond\(/);
});

/* ── Runs: reconnectable, exactly once ───────────────────────────────────── */

test("a run reads as what happened — and one that died with its server says so", () => {
  const now = new Date("2026-10-07T10:00:00Z");
  const result = { ok: true as const, answer: "Hi", rows: [], tools: [], learned: 0, actions: [], choices: [], saved: true };
  assert.deepEqual(runView({ status: "completed", statusText: null, partial: "Hi", result, updatedAt: now }, now).result, result);
  const working = runView({ status: "answering", statusText: "Writing it up…", partial: "Gav", result: null, updatedAt: now }, now);
  assert.equal(working.result, null);
  assert.equal(working.partial, "Gav");
  const dead = runView({ status: "researching", statusText: null, partial: null, result: null, updatedAt: new Date(now.getTime() - RUN_STALE_MS - 1) }, now);
  assert.equal(dead.status, "failed");
  assert.deepEqual(dead.result, RUN_LOST);
});

test("runs are claimed by a unique key per person per workspace, and every read and write names both", () => {
  const run = code("src/lib/assistantRun.ts");
  assert.match(run, /error\.code === "P2002"/);
  assert.equal((run.match(/where: \{ tenantId_userId_clientKey: \{ tenantId, userId, clientKey \} \}/g) ?? []).length, 2, "the claim's fallback and the read");
  assert.match(run, /if \(!run \|\| run\.tenantId !== tenantId \|\| run\.userId !== userId\) return null;/);
  assert.match(run, /prisma\.assistantRun\.updateMany\(\{ where: \{ id, tenantId, userId \}, data \}\)/);
  assert.match(run, /where: \{ tenantId: inheritedTenantId\(\), status: "completed"/, "the owner's speed view is this workspace's runs");
  assert.doesNotMatch(run, /\buserId_clientKey/, "no lookup by person and key alone");
  const schema = code("prisma/schema.prisma");
  assert.match(schema, /model AssistantRun \{[\s\S]*?@@unique\(\[tenantId, userId, clientKey\]\)/);
  const sql = readFileSync(new URL("../prisma/migrations/20261007090000_assistant_runs/migration.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "AssistantRun_tenantId_userId_clientKey_key" ON "AssistantRun"\("tenantId", "userId", "clientKey"\);/);
  assert.doesNotMatch(sql, /ON "AssistantRun"\("userId", "clientKey"\)/);
  assert.match(sql, /ALTER TABLE "AssistantRun" ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /ALTER TABLE "AssistantRun" FORCE ROW LEVEL SECURITY;/);
  // Swept after a week with the 30-day turn sweep.
  assert.match(code("src/app/api/cron/automations/route.ts"), /basePrisma\.assistantRun\s*\.deleteMany\(\{ where: \{ createdAt: \{ lt: new Date\(Date\.now\(\) - 7 \* 24 \* 60 \* 60 \* 1000\) \} \} \}\)/);
});

/* ── Timings ─────────────────────────────────────────────────────────────── */

test("each phase is timed — numbers only — and the median is what the owner sees", () => {
  const lib = code("src/lib/crmAssistant.ts");
  for (const phase of ['mark("context")', "mark(`plan${step + 1}`)", "mark(`lookups${round}`)", "timings.answerFirstText", "timings.firstText", "timings.answer =", "timings.total ="]) {
    assert.ok(lib.includes(phase), phase);
  }
  assert.deepEqual(medianTimings([{ context: 100, total: 9000 }, { context: 300, total: 7000 }, { context: 200 }, null, { total: "x" }]), { context: 200, total: 8000 });
  assert.match(code("src/app/api/assistant/ask/route.ts"), /await recorder\?\.finish\(result, timings\);/);
});

/* ── Stale cards ─────────────────────────────────────────────────────────── */

test("a card about a record that has moved on is refused, not applied", () => {
  const action = code("src/app/actions/assistant.ts");
  for (const kind of ["assign", "stage", "reschedule", "cancel_activity", "lost"]) {
    assert.match(action, new RegExp(`case "${kind}": \\{\\s*if \\(!\\(await stillAsProposed\\(card\\)\\)\\) return \\{ ok: false, error: STALE_CARD \\};`), kind);
  }
  const check = action.slice(action.indexOf("async function stillAsProposed"));
  assert.match(check, /if \(card\.kind === "stage"\) return lead\.stageId === card\.fromStageId;/);
  assert.match(check, /if \(card\.kind === "assign"\) return lead\.assignedToId === card\.fromUserId;/);
  assert.match(check, /activity\.status === "planned" && activity\.dueDate\.toISOString\(\) === card\.fromDue/);
  assert.match(check, /if \(!lead \|\| lead\.status !== "open"\) return false;/);
  const lib = code("src/lib/crmAssistant.ts");
  assert.match(lib, /stageId: stage\.id, fromStageId: lead\.stageId \}/);
  assert.match(lib, /userId: person\.id, fromUserId: lead\.assignedToId \}/);
  assert.equal((lib.match(/fromDue: activity\.dueDate\.toISOString\(\)/g) ?? []).length, 2);
});
