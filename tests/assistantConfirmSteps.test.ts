import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import Module, { createRequire } from "node:module";
import { Prisma } from "@prisma/client";
import { confirmReply } from "../src/lib/assistantConfirmStepsRules";
import { STEP_STALE_MS } from "../src/lib/assistantPlanRules";

/*
 * A Confirm card that writes in steps (risk assessment 2026-11-15, Phase 1): a repeat Confirm runs only what isn't
 * done, a blip carries on from where it stopped, two at once never run a step twice, and the reply says what happened.
 * Run against a fake AssistantPendingAction table that behaves like Postgres on the calls the helper makes (a primary
 * key that refuses a second row, conditional updates that report their count).
 */

type Row = { id: string; tenantId: string; userId: string; forCrm: boolean; card: unknown; confirmedAt: Date | null; completedAt: Date | null; expiresAt: Date };
let rows: Row[] = [];
const errors: string[] = [];
const same = (have: unknown, want: unknown) => (want instanceof Date ? have instanceof Date && have.getTime() === want.getTime() : want === null ? have === null : have === want);
const hit = (row: Row, where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => same((row as never)[k], v));
const table = {
  create: async ({ data }: { data: Omit<Row, "completedAt"> }) => {
    if (rows.some((r) => r.id === data.id)) throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" });
    rows.push({ completedAt: null, ...data });
    return data;
  },
  findFirst: async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => hit(r, where)) ?? null,
  updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
    const found = rows.filter((r) => hit(r, where));
    for (const r of found) Object.assign(r, data);
    return { count: found.length };
  },
  deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
    const before = rows.length;
    rows = rows.filter((r) => !hit(r, where));
    return { count: before - rows.length };
  },
};

type Loader = (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const loader = Module as unknown as { _load: Loader };
const realLoad = loader._load;
loader._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only") return {};
  if ((parent?.filename ?? "").replace(/\\/g, "/").endsWith("src/lib/assistantConfirmSteps.ts")) {
    if (request === "./db") return { basePrisma: { assistantPendingAction: table } };
    if (request === "./errorLog") return { logError: async (...args: unknown[]) => { errors.push(args.map(String).join(" ")); } };
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;
const { runConfirmSteps } = createRequire(import.meta.url)("../src/lib/assistantConfirmSteps.ts") as typeof import("../src/lib/assistantConfirmSteps");

const T = "tenant_a", U = "user_1", KEY = `qk_${"a".repeat(32)}`;
let ran: string[] = [];
let failNext: string | null = null;
/** Two steps that record each run; `failNext` makes the named one throw once (a database blip). */
const steps = (second: () => Promise<{ done: string } | { refused: string } | { unsure: string }> = async () => ({ done: "Parked" })) => [
  { name: "reopen", label: "reopening the deal", run: async () => { ran.push("reopen"); if (failNext === "reopen") { failNext = null; throw new Error("ECONNRESET"); } return { done: "Reopened" }; } },
  { name: "park", label: "moving it to Nurture", run: async () => { ran.push("park"); if (failNext === "park") { failNext = null; throw new Error("ECONNRESET"); } return second(); } },
];
beforeEach(() => { rows = []; ran = []; failNext = null; errors.length = 0; });

test("all steps run once: saved, and every claim row is done — and kept out of every 'waiting' list", async () => {
  const out = await runConfirmSteps(T, U, KEY, steps());
  assert.deepEqual(out, { kind: "saved", done: ["Reopened", "Parked"] });
  assert.deepEqual(ran, ["reopen", "park"]);
  assert.deepEqual(rows.map((r) => r.id), [`${KEY}:reopen`, `${KEY}:park`]);
  // Cards waiting for a Confirm are read as forCrm false, or confirmedAt null: a step row is neither, ever.
  assert.ok(rows.every((r) => r.forCrm === true && r.confirmedAt !== null && r.completedAt !== null && r.tenantId === T && r.userId === U));
});

test("step 2 throws once: logged by name only, its claim released; the retry runs ONLY step 2", async () => {
  failNext = "park";
  const first = await runConfirmSteps(T, U, KEY, steps());
  assert.deepEqual(first, { kind: "retry", done: ["Reopened"], failed: "moving it to Nurture" });
  assert.equal(rows.some((r) => r.id === `${KEY}:park`), false, "released, so it runs again");
  assert.match(errors.join("\n"), /confirm step "park" threw Error/);
  const second = await runConfirmSteps(T, U, KEY, steps());
  assert.deepEqual(second, { kind: "saved", done: ["Reopened", "Parked"] });
  assert.deepEqual(ran, ["reopen", "park", "park"], "the reopen was never repeated");
  const reply = confirmReply(first);
  assert.equal(reply.ok, false);
  assert.equal(reply.resumable, true);
  assert.match(reply.error!, /^Reopened\. Couldn't finish moving it to Nurture just now\. Confirm again to carry on — what's done won't be repeated\.$/);
});

test("already done: a second Confirm runs nothing and says so", async () => {
  await runConfirmSteps(T, U, KEY, steps());
  ran = [];
  const again = await runConfirmSteps(T, U, KEY, steps());
  assert.deepEqual(again, { kind: "already", done: ["Reopened", "Parked"] });
  assert.deepEqual(ran, []);
  assert.deepEqual(confirmReply(again), { ok: true, success: "Already done — nothing was done twice. Reopened. Parked." });
});

test("partly saved: a refused step after a done one says which part and why, and can be confirmed again", async () => {
  const out = await runConfirmSteps(T, U, KEY, steps(async () => ({ refused: "The review date has passed." })));
  assert.deepEqual(out, { kind: "partly", done: ["Reopened"], notDone: { label: "moving it to Nurture", why: "The review date has passed.", retry: true } });
  assert.equal(rows.some((r) => r.id === `${KEY}:park`), false, "a refusal wrote nothing: its claim goes");
  assert.deepEqual(confirmReply(out), {
    ok: false, resumable: true,
    error: "Reopened. Not done: moving it to Nurture — The review date has passed. Confirm again to finish — what's done won't be repeated.",
  });
  // An unsure step is final: completed as unsure, never run again, and said.
  rows = []; ran = [];
  const unsure = await runConfirmSteps(T, U, KEY, steps(async () => ({ unsure: "it may not have been filed" })));
  assert.equal(confirmReply(unsure).ok, true);
  assert.equal(confirmReply(unsure).success, "Reopened. Not done: moving it to Nurture — it may not have been filed.");
  ran = [];
  assert.deepEqual(await runConfirmSteps(T, U, KEY, steps()), unsure, "the same answer, and nothing runs");
  assert.deepEqual(ran, []);
});

test("refused at the first step: nothing written, no claim left, and the reply is the refusal (never 'nothing changed')", async () => {
  const out = await runConfirmSteps(T, U, KEY, [{ name: "payment", label: "recording the payment", run: async () => ({ refused: "That quote has no balance left." }) }]);
  assert.deepEqual(out, { kind: "refused", why: "That quote has no balance left." });
  assert.equal(rows.length, 0);
  // A delegate's refusal is unproven (the house rule): not `unchanged`, not offered as a retry.
  assert.deepEqual(confirmReply(out), { ok: false, error: "That quote has no balance left." });
});

test("two Confirms at once: one runs the step, the other is told it's being saved — never run twice", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slow = [{ name: "payment", label: "recording the payment", run: async () => { ran.push("payment"); await gate; return { done: "Paid" }; } }];
  const first = runConfirmSteps(T, U, KEY, slow);
  await new Promise((resolve) => setImmediate(resolve));
  const second = await runConfirmSteps(T, U, KEY, slow);
  assert.deepEqual(second, { kind: "busy", done: [] });
  assert.equal(confirmReply(second).resumable, true);
  release();
  assert.deepEqual(await first, { kind: "saved", done: ["Paid"] });
  assert.deepEqual(ran, ["payment"]);
});

test("a claim left by a request that died part-way is taken over once it is stale — not before", async () => {
  const old = new Date(Date.now() - STEP_STALE_MS - 1000);
  rows.push({ id: `${KEY}:reopen`, tenantId: T, userId: U, forCrm: true, card: {}, confirmedAt: old, completedAt: null, expiresAt: new Date(Date.now() + 1e9) });
  const out = await runConfirmSteps(T, U, KEY, steps());
  assert.deepEqual(out, { kind: "saved", done: ["Reopened", "Parked"] });
  rows = []; ran = [];
  rows.push({ id: `${KEY}:reopen`, tenantId: T, userId: U, forCrm: true, card: {}, confirmedAt: new Date(), completedAt: null, expiresAt: new Date(Date.now() + 1e9) });
  assert.deepEqual(await runConfirmSteps(T, U, KEY, steps()), { kind: "busy", done: [] });
  assert.deepEqual(ran, []);
});

test("another person's or workspace's row with the same id is never read as this card's", async () => {
  rows.push({ id: `${KEY}:reopen`, tenantId: "tenant_b", userId: U, forCrm: true, card: { result: { done: "theirs" } }, confirmedAt: new Date(), completedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) });
  const out = await runConfirmSteps(T, U, KEY, steps());
  assert.deepEqual(out, { kind: "busy", done: [] }, "the id is taken, and nothing of theirs is reported or run");
  assert.deepEqual(ran, []);
});
