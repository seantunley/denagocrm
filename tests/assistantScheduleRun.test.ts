import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import Module, { createRequire } from "node:module";
import { SCHEDULE_UNSAVED_NOTE } from "../src/lib/assistantSchedule";

/*
 * The scheduler, run for real against fakes (no database, no ChatGPT, no push
 * service). It pins the two reliability rules from the #773 review:
 *  1. who the person is is settled BEFORE the run is claimed — a failure to
 *     check consumes nothing and switches nothing off;
 *  2. "Your scheduled briefing is ready" only when a briefing was SAVED.
 */

type Row = { id: string; tenantId: string; userId: string; question: string; cadence: string; weekday: number | null; timeOfDay: string; onDate: string | null; nextRunAt: Date | null; active: boolean; lastRunAt?: Date | null };
type Where = Record<string, unknown>;

const due = new Date(Date.now() - 60_000);
const state = {
  rows: [] as Row[],
  turns: [] as { answer: string }[],
  pushes: [] as string[],
  asked: 0,
  userMode: "ok" as "ok" | "gone" | "throws",
  answer: { ok: true, saved: true } as { ok: boolean; saved?: boolean; error?: string },
  turnWriteFails: false,
};

const matches = (row: Row, where: Where) =>
  Object.entries(where).every(([key, value]) => {
    const actual = (row as Record<string, unknown>)[key];
    if (value && typeof value === "object" && !(value instanceof Date) && "lte" in value) return actual instanceof Date && actual <= (value as { lte: Date }).lte;
    if (value instanceof Date) return actual instanceof Date && actual.getTime() === value.getTime();
    return actual === value;
  });

const fakePrisma = {
  assistantSchedule: {
    findMany: async ({ where }: { where: Where }) => state.rows.filter((r) => matches(r, where)).map((r) => ({ ...r })),
    updateMany: async ({ where, data }: { where: Where; data: Partial<Row> }) => {
      const hit = state.rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
  },
  assistantTurn: {
    create: async ({ data }: { data: { answer: string } }) => {
      if (state.turnWriteFails) throw new Error("write failed");
      state.turns.push({ answer: data.answer });
      return data;
    },
  },
};

type Loader = (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const loader = Module as unknown as { _load: Loader };
const realLoad = loader._load;
const fromRunner = (parent: { filename?: string } | undefined) => (parent?.filename ?? "").replace(/\\/g, "/").endsWith("src/lib/assistantScheduleRun.ts");
loader._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only") return {};
  if (fromRunner(parent)) {
    switch (request) {
      case "./db": return { prisma: fakePrisma };
      case "./errorLog": return { logError: async () => {} };
      case "./tenantScope": return { currentTenantScope: () => ({ tenantId: "t1", system: false }) };
      case "./settings": return { getSetting: async () => null };
      case "./push": return { sendPushToAll: async (p: { body: string }) => { state.pushes.push(p.body); return 1; } };
      case "./assistantUser": return {
        assistantUserFor: async (id: string) => {
          if (state.userMode === "throws") throw new Error("permissions unavailable");
          return state.userMode === "gone" ? null : { id, name: id, email: `${id}@x`, role: "member" };
        },
        assistantAskAllowed: async () => true,
      };
      case "./crmAssistant": return {
        askCrm: async () => {
          state.asked++;
          return state.answer.ok
            ? { ok: true, answer: "Two deals went quiet.", rows: [], tools: [], learned: 0, actions: [], choices: [], saved: state.answer.saved }
            : { ok: false, error: state.answer.error ?? "failed" };
        },
      };
    }
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const require_ = createRequire(import.meta.url);
const { runDueAssistantSchedules } = require_("../src/lib/assistantScheduleRun.ts") as typeof import("../src/lib/assistantScheduleRun");
const budget = { shouldStop: () => false } as unknown as Parameters<typeof runDueAssistantSchedules>[0];

beforeEach(() => {
  state.rows = [{ id: "s1", tenantId: "t1", userId: "u1", question: "Which deals went quiet?", cadence: "daily", weekday: null, timeOfDay: "07:00", onDate: null, nextRunAt: due, active: true }];
  state.turns = [];
  state.pushes = [];
  state.asked = 0;
  state.userMode = "ok";
  state.answer = { ok: true, saved: true };
  state.turnWriteFails = false;
});

test("a failure to CHECK the person consumes nothing: still due, still on, nothing asked or sent", async () => {
  state.userMode = "throws";
  await runDueAssistantSchedules(budget);
  assert.equal(state.rows[0].nextRunAt?.getTime(), due.getTime(), "not advanced — tried again next tick");
  assert.equal(state.rows[0].active, true, "not switched off");
  assert.equal(state.asked, 0);
  assert.equal(state.pushes.length, 0);
  // Next tick, the check works: it runs.
  state.userMode = "ok";
  await runDueAssistantSchedules(budget);
  assert.equal(state.asked, 1);
  assert.ok((state.rows[0].nextRunAt?.getTime() ?? 0) > Date.now(), "claimed and advanced only when it really ran");
});

test("a person who is definitely gone switches the schedule off — and is never asked for", async () => {
  state.userMode = "gone";
  await runDueAssistantSchedules(budget);
  assert.equal(state.rows[0].active, false);
  assert.equal(state.asked, 0);
  assert.equal(state.pushes.length, 0);
});

test("'ready' only for a SAVED briefing", async () => {
  await runDueAssistantSchedules(budget);
  assert.deepEqual(state.pushes, ["Your scheduled briefing is ready."]);
  assert.equal(state.turns.length, 0, "askCrm saved it; no note on top");
});

test("an answer whose save failed: a note is saved and the push says it couldn't run — never 'ready'", async () => {
  state.answer = { ok: true, saved: false };
  await runDueAssistantSchedules(budget);
  assert.deepEqual(state.turns.map((t) => t.answer), [SCHEDULE_UNSAVED_NOTE]);
  assert.deepEqual(state.pushes, ["A scheduled question couldn't run — open to see why."]);
});

test("when nothing at all could be saved, no push — it would open onto an empty thread", async () => {
  state.answer = { ok: true, saved: false };
  state.turnWriteFails = true;
  await runDueAssistantSchedules(budget);
  assert.equal(state.pushes.length, 0);
  state.rows[0].nextRunAt = due;
  state.answer = { ok: false, error: "failed" };
  await runDueAssistantSchedules(budget);
  assert.equal(state.pushes.length, 0, "a failure note that couldn't be saved isn't announced either");
});
