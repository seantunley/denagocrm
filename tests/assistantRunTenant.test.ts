import assert from "node:assert/strict";
import { test } from "node:test";
import Module, { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";

/*
 * #788 review: a run key is one person's in ONE workspace. The REAL run module,
 * against a table that behaves as the database does with tenant enforcement
 * OFF — no ambient filter, so the module's own predicates are the only
 * boundary — and the same person belonging to workspaces A and B.
 */

type Row = { id: string; tenantId: string; userId: string; clientKey: string; status: string; statusText: string | null; partial: string | null; result: unknown; updatedAt: Date };
const rows: Row[] = [];
// Equality, plus the status filters the run module uses ({ in }, { not }).
const matches = (row: Row, where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) => {
    const value = row[k as keyof Row];
    if (v && typeof v === "object" && "in" in v) return (v.in as unknown[]).includes(value);
    if (v && typeof v === "object" && "not" in v) return value !== v.not;
    return value === v;
  });
// A compound-unique lookup ({ a_b_c: { a, b, c } }) is a match on its fields.
const flat = (where: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(where).flatMap(([k, v]) => (v && typeof v === "object" && !(v instanceof Date) ? Object.entries(v) : [[k, v]])));

const prisma = {
  assistantRun: {
    create: async ({ data }: { data: { tenantId: string; userId: string; clientKey: string } }) => {
      // The table's unique index, as the schema declares it.
      if (rows.some((r) => r.tenantId === data.tenantId && r.userId === data.userId && r.clientKey === data.clientKey)) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
      }
      const row = { id: `run_${rows.length + 1}`, status: "accepted", statusText: null, partial: null, result: null, updatedAt: new Date(), ...data } as Row;
      rows.push(row);
      return { id: row.id };
    },
    findUnique: async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => matches(r, flat(where))) ?? null,
    findFirst: async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => matches(r, where)) ?? null,
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data, { updatedAt: new Date() }));
      return { count: hit.length };
    },
  },
};

type Loader = (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const loader = Module as unknown as { _load: Loader };
const realLoad = loader._load;
loader._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only") return {};
  const file = (parent?.filename ?? "").replace(/\\/g, "/");
  if (file.endsWith("src/lib/assistantRun.ts")) {
    if (request === "./db") return { prisma };
    if (request === "./errorLog") return { logError: async () => {} };
    if (request === "./tenantWrite") return { inheritedTenantId: () => "tenant_a" };
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const { claimRun, readRun, runRecorder, stopRun, RUN_STOPPED } = createRequire(import.meta.url)("../src/lib/assistantRun.ts") as typeof import("../src/lib/assistantRun");

const KEY = "k_known_run_key_123";
const done = { ok: true as const, answer: "Workspace A's answer", rows: [], tools: [], learned: 0, actions: [], choices: [], saved: true };

test("a run key from workspace A, replayed by the same person from B, reaches nothing of A's", async () => {
  const a = await claimRun("tenant_a", "user_1", KEY);
  assert.equal(a.created, true);
  await runRecorder(a.id, "tenant_a", "user_1").finish(done, { total: 1 });

  // From B: the reconnect read finds nothing…
  assert.equal(await readRun("tenant_b", "user_1", KEY), null);
  // …a POST with the same key is a NEW run in B, not a follow of A's…
  const b = await claimRun("tenant_b", "user_1", KEY);
  assert.equal(b.created, true, "the same key exists independently in both workspaces");
  assert.notEqual(b.id, a.id);
  // …and a recorder bound to B can't write A's row, even given its id.
  await runRecorder(a.id, "tenant_b", "user_1").finish({ ok: false, error: "overwritten" }, {});

  const still = await readRun("tenant_a", "user_1", KEY);
  assert.equal(still?.status, "completed");
  assert.deepEqual(still?.result, done);
  // A retry in A still follows A's own run — exactly once there.
  assert.deepEqual(await claimRun("tenant_a", "user_1", KEY), { id: a.id, created: false });
});

/* ── Stop and correct ────────────────────────────────────────────────────── */

const statusOf = (id: string) => rows.find((r) => r.id === id)?.status;

test("Stop reaches only the asker's own run in its own workspace", async () => {
  const key = "k_stop_own_run_only";
  const run = await claimRun("tenant_a", "user_1", key);
  runRecorder(run.id, "tenant_a", "user_1").phase("researching", "Checking leads…");
  // Someone else in A, and the same person from B, each "stop" that key: neither touches A's run.
  await stopRun("tenant_a", "user_2", key);
  await stopRun("tenant_b", "user_1", key);
  assert.equal(statusOf(run.id), "researching");
  // Their stops were recorded as their OWN (empty) runs under that key — nothing of user_1's in A.
  assert.ok(rows.filter((r) => r.clientKey === key && r.id !== run.id).every((r) => r.status === "stopped" && !(r.tenantId === "tenant_a" && r.userId === "user_1")));
  // The asker's own Stop works.
  assert.equal(await stopRun("tenant_a", "user_1", key), "stopped");
  assert.equal(statusOf(run.id), "stopped");
});

test("a stopped run keeps nothing: askCrm is told at its next step and at the last word, and nothing revives it", async () => {
  const key = "k_stop_keeps_nothing";
  const run = await claimRun("tenant_a", "user_1", key);
  const recorder = runRecorder(run.id, "tenant_a", "user_1");
  assert.equal(await recorder.stillWanted(false), true);
  assert.equal(await stopRun("tenant_a", "user_1", key), "stopped");
  assert.equal(await recorder.stillWanted(false), false, "the next research step ends it");
  assert.equal(await recorder.stillWanted(true), false, "the last word refuses to keep anything");
  // Late progress writes and the finish never overwrite the stop.
  recorder.phase("answering");
  recorder.partial("Gavin wants the four-seater");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await recorder.finish({ ok: true, answer: "x", rows: [], tools: [], learned: 0, actions: [], choices: [], saved: false }, {}), true, "finish says it was stopped");
  const read = await readRun("tenant_a", "user_1", key);
  assert.equal(read?.status, "stopped");
  assert.deepEqual(read?.result, RUN_STOPPED, "a reconnect sees the stop, never a card");
});

test("Stop and keeping race to one winner: once the answer is claimed for keeping, Stop is too late", async () => {
  const key = "k_stop_too_late";
  const run = await claimRun("tenant_a", "user_1", key);
  const recorder = runRecorder(run.id, "tenant_a", "user_1");
  assert.equal(await recorder.stillWanted(true), true, "claimed for keeping");
  assert.equal(statusOf(run.id), "saving");
  assert.equal(await stopRun("tenant_a", "user_1", key), "finished", "too late — its answer stands");
  assert.equal(await recorder.finish({ ok: true, answer: "Done", rows: [], tools: [], learned: 0, actions: [], choices: [], saved: true }, {}), false);
  assert.equal(statusOf(run.id), "completed");
});

test("a Stop that overtakes its own question leaves it nothing to run", async () => {
  const key = "k_stop_before_post";
  assert.equal(await stopRun("tenant_a", "user_1", key), "stopped");
  // The question arrives afterwards: it finds the run already there, so it only reads it — and reads the stop.
  const late = await claimRun("tenant_a", "user_1", key);
  assert.equal(late.created, false);
  assert.deepEqual((await readRun("tenant_a", "user_1", key))?.result, RUN_STOPPED);
});

const code = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("askCrm checks for a stop before each round, before the answer, and before ANY write", () => {
  const lib = code("src/lib/crmAssistant.ts");
  const body = lib.slice(lib.indexOf("export async function askCrm("), lib.indexOf("export async function resolveActions("));
  const loop = body.indexOf("for (let step = 0; research");
  assert.ok(body.indexOf("if (await stopped()) return STOPPED;", loop) > loop, "each research round");
  assert.match(body, /if \(await stopped\(\)\) return STOPPED;\s*if \(observations\.length\) progress\("Writing it up…"\);/, "before the answer");
  const last = body.indexOf("if (await stopped(true)) return STOPPED;");
  assert.ok(last > body.indexOf("const answerReply = await withRetry("), "after the answer is written");
  for (const write of ["applyTaskUpdate(", "resolveActions(", "proposePlan(", "setCheckBacks(", "applyLearn(", "saveDecision(", "logAudit(", "prisma.assistantTurn", "linkUpload("]) {
    const at = body.indexOf(write, body.indexOf("const answerReply = await withRetry("));
    assert.ok(at > last, `${write} only after the last stop check`);
  }
  assert.match(lib, /stillWanted\?: \(final: boolean\) => Promise<boolean>;/);
});

test("the stop route: same checks as asking, the person's own run in this workspace, and the result of a stopped run is the stop", () => {
  const route = code("src/app/api/assistant/ask/route.ts");
  const del = route.slice(route.indexOf("export async function DELETE"));
  const order = ["isSameOrigin(req.headers)", "withActingStaffScope(", "signedInAsker()", "RUN_KEY.test(key)", "const tenantId = inheritedTenantId();", "stopRun(tenantId, asker.user.id, key)"];
  for (let i = 1; i < order.length; i++) assert.ok(del.indexOf(order[i - 1]) >= 0 && del.indexOf(order[i - 1]) < del.indexOf(order[i]), `${order[i - 1]} before ${order[i]}`);
  assert.doesNotMatch(del, /askAsPerson|claimRun/);
  assert.match(route, /stillWanted: recorder\?\.stillWanted,/);
  assert.match(route, /const stopped = await recorder\?\.finish\(result, timings\);\s*send\(\{ t: "done", r: stopped \? RUN_STOPPED : result \}\);/);
});
