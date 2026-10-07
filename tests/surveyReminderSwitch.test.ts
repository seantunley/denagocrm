import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import Module, { createRequire } from "node:module";

/*
 * ONE PATH PER SURVEY REMINDER (2026-10-06). A survey sent automatically (after
 * a job card, a delivery or a won deal) is reminded ONLY by the "Survey reminder"
 * journey's step (sendSurveyReminder), off unless the owner switches it on; the
 * queue's sendDueReminders reminds only distributions a PERSON created. Run
 * against fakes: a fake database that applies each query's filter, and fake
 * senders that record what went out.
 */

type Row = { id: string; source: string | null; maxReminders: number; reminderCount: number; reminded?: boolean };
const state = {
  rows: [] as Row[],
  claimed: [] as string[],
  sent: [] as { to: string; subject?: string; text: string }[],
  writes: [] as string[],
  verdict: { allowed: true, destination: "lisa@example.com" } as { allowed: boolean; destination?: string; reason?: string },
};

const invite = (r: Row) => ({
  id: r.id, tenantId: "t1", distributionId: `d_${r.id}`, surveyId: "s1", surveyVersion: 1, contactId: "c1", token: `tok_${r.id}`,
  name: "Lisa Moulder", attemptCount: 1, reminderCount: r.reminderCount, maxReminders: r.maxReminders,
  distributionChannel: "email", distributionStatus: "sending", purpose: "survey_transactional",
  snapshot: { title: "How did we do?", type: "csat", intro: "Two quick questions", questions: [] },
  audienceSource: r.source, email: "lisa@example.com", phone: null, whatsapp: null,
});

const fakeBase = {
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("FOR UPDATE OF r SKIP LOCKED") && sql.includes("reminder_sending")) {
      // The queue's claim: the automatic-survey exclusion is unconditional now.
      assert.match(sql, /AND COALESCE\(d\."audienceSnapshot"->>'source', ''\) <> 'automation_trigger'/);
      const due = state.rows.filter((r) => r.reminderCount < r.maxReminders && r.source !== "automation_trigger");
      state.claimed.push(...due.map((r) => r.id));
      return due.map(invite);
    }
    if (sql.includes("WITH claimed AS (") && sql.includes(`r."lastReminderAt" IS NULL`)) {
      // The journey step's claim: one response, automatic surveys only, never reminded.
      assert.match(sql, /= 'automation_trigger'/);
      const [responseId, tenantId] = values as string[];
      assert.equal(tenantId, "t1", "the tenant is named in the claim");
      const row = state.rows.find((r) => r.id === responseId && r.source === "automation_trigger" && !r.reminded);
      if (!row) return [];
      row.reminded = true;
      state.claimed.push(row.id);
      return [invite(row)];
    }
    return [];
  },
  $executeRaw: async (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    if (sql.includes(`"lastReminderAt" = NULL`)) {
      state.writes.push("released");
      for (const r of state.rows) r.reminded = false;
    } else {
      state.writes.push("updated");
    }
    return 1;
  },
};

type Loader = (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const loader = Module as unknown as { _load: Loader };
const realLoad = loader._load;
const fromQueue = (parent: { filename?: string } | undefined) => (parent?.filename ?? "").replace(/\\/g, "/").endsWith("src/lib/surveyDistributionQueue.ts");
loader._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only") return {};
  if (fromQueue(parent)) {
    switch (request) {
      case "./db": return { basePrisma: fakeBase, prisma: fakeBase };
      case "./email": return { sendEmail: async (m: { to: string; subject?: string; text: string }) => { state.sent.push(m); return { ok: true }; } };
      case "./sms": return { sendSms: async (to: string, text: string) => { state.sent.push({ to, text }); return { ok: true }; } };
      case "./communicationPolicy": return {
        canContactPerson: async () => state.verdict,
        classifyRetry: () => "permanent",
        describeBlockedReason: (reason?: string) => reason ?? "not contactable",
        nextCommunicationWindow: () => new Date("2026-10-07T08:00:00Z"),
      };
      case "./tenantScope": return { currentTenantScope: () => ({ tenantId: "t1", system: false }) };
      case "./tenantBrand": return { DEFAULT_BRAND: { displayName: "Denago" }, brandForTenant: async () => ({ displayName: "Denago" }) };
      case "./tenantOrigin": return { tenantOrigin: async () => "https://crm.example" };
      case "./signing/signingEmail": return {
        tenantEmailContent: async (kind: string, _t: string, vars: Record<string, string>) => ({ subject: `[${kind}] ${vars.survey_title}`, text: `${kind}: ${vars.survey_link}`, html: "<p/>" }),
        tenantSmsContent: async (kind: string) => kind,
      };
    }
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const require_ = createRequire(import.meta.url);
const { sendDueReminders, sendSurveyReminder } = require_("../src/lib/surveyDistributionQueue.ts") as typeof import("../src/lib/surveyDistributionQueue");

beforeEach(() => {
  state.rows = [];
  state.claimed = [];
  state.sent = [];
  state.writes = [];
  state.verdict = { allowed: true, destination: "lisa@example.com" };
});

test("the queue never reminds an automatic survey — even one created with a reminder count", async () => {
  state.rows = [{ id: "auto1", source: "automation_trigger", maxReminders: 1, reminderCount: 0 }];
  assert.equal(await sendDueReminders("t1"), 0);
  assert.deepEqual(state.claimed, []);
  assert.deepEqual(state.sent, []);
});

test("a distribution a PERSON created keeps its own reminder setting", async () => {
  state.rows = [{ id: "manual1", source: "distribution", maxReminders: 1, reminderCount: 0 }, { id: "manual2", source: null, maxReminders: 2, reminderCount: 1 }];
  assert.equal(await sendDueReminders("t1"), 2);
  assert.deepEqual(state.claimed.sort(), ["manual1", "manual2"]);
  // …and one with no reminders set gets none.
  state.rows = [{ id: "manual3", source: "distribution", maxReminders: 0, reminderCount: 0 }];
  state.sent = [];
  assert.equal(await sendDueReminders("t1"), 0);
  assert.deepEqual(state.sent, []);
});

test("the journey step sends ONE reminder for an automatic survey, in the editable template, with the link", async () => {
  state.rows = [{ id: "auto1", source: "automation_trigger", maxReminders: 0, reminderCount: 0 }];
  assert.deepEqual(await sendSurveyReminder("auto1", "t1"), { kind: "sent" });
  assert.equal(state.sent.length, 1);
  assert.match(state.sent[0].subject ?? "", /^\[survey_reminder\]/, "Settings → Email templates → Survey reminder");
  assert.match(state.sent[0].text, /https:\/\/crm\.example\/s\/tok_auto1/);
  // A second run, a retry, a republished version: the claim is gone, nothing sends.
  assert.equal((await sendSurveyReminder("auto1", "t1")).kind, "skipped");
  assert.equal(state.sent.length, 1, "once per survey, however often the step runs");
});

test("the journey step can't remind a survey a person sent — that is the queue's", async () => {
  state.rows = [{ id: "manual1", source: "distribution", maxReminders: 1, reminderCount: 0 }];
  assert.equal((await sendSurveyReminder("manual1", "t1")).kind, "skipped");
  assert.deepEqual(state.sent, []);
});

test("quiet hours hold the step and hand the claim back, so the retry can send", async () => {
  state.rows = [{ id: "auto1", source: "automation_trigger", maxReminders: 0, reminderCount: 0 }];
  state.verdict = { allowed: false, reason: "quiet_hours" };
  const held = await sendSurveyReminder("auto1", "t1");
  assert.equal(held.kind, "deferred");
  assert.deepEqual(state.sent, []);
  assert.ok(state.writes.includes("released"));
  state.verdict = { allowed: true, destination: "lisa@example.com" };
  assert.equal((await sendSurveyReminder("auto1", "t1")).kind, "sent");
});

test("an opt-out is respected: nothing sent, and the step says why", async () => {
  state.rows = [{ id: "auto1", source: "automation_trigger", maxReminders: 0, reminderCount: 0 }];
  state.verdict = { allowed: false, reason: "marketing_opt_out" };
  assert.deepEqual(await sendSurveyReminder("auto1", "t1"), { kind: "skipped", reason: "marketing_opt_out" });
  assert.deepEqual(state.sent, []);
});

test("an automatic survey is created with no queue reminder at all", () => {
  const runtime = readFileSync("src/lib/governedSurveyRuntime.ts", "utf8");
  assert.match(runtime, /maxReminders: 0,/);
  assert.doesNotMatch(runtime, /automationOn|SURVEY_AUTO_REMINDERS/);
});
