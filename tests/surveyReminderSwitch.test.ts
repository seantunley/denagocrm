import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import Module, { createRequire } from "node:module";

/*
 * #784 review: "Survey reminders (automatic surveys)" must be a LIVE switch.
 * It was read only when an automatic distribution was created, so one created
 * while it was on still reminded the customer after the owner switched it off.
 * The real sendDueReminders, against fakes: a fake database that applies the
 * query's filter, and fake senders that record what went out.
 */

type Row = { id: string; source: string | null; maxReminders: number; reminderCount: number };
const state = {
  switchOn: false,
  rows: [] as Row[],
  claimed: [] as string[],
  sent: [] as { to: string; subject?: string; text: string }[],
  leases: [] as string[],
};

const fakeBase = {
  // The reminder claim query. The only boolean parameter is the switch; the fake
  // applies the same rule the SQL does, so a reminder that shouldn't be claimed isn't.
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (!sql.includes("reminder_sending")) return [];
    const autoOn = values.find((v) => typeof v === "boolean") as boolean;
    assert.match(sql, /COALESCE\(d\."audienceSnapshot"->>'source', ''\) <> 'automation_trigger'/, "the filter is in the claim query");
    const due = state.rows.filter((r) => r.reminderCount < r.maxReminders && (autoOn || r.source !== "automation_trigger"));
    state.claimed.push(...due.map((r) => r.id));
    return due.map((r) => ({
      id: r.id, tenantId: "t1", distributionId: `d_${r.id}`, surveyId: "s1", surveyVersion: 1, contactId: "c1", token: `tok_${r.id}`,
      name: "Lisa Moulder", attemptCount: 1, reminderCount: r.reminderCount, maxReminders: r.maxReminders,
      distributionChannel: "email", distributionStatus: "sending", purpose: "survey_transactional",
      snapshot: { title: "How did we do?", type: "csat", intro: "Two quick questions", questions: [] },
      audienceSource: r.source, email: "lisa@example.com", phone: null, whatsapp: null,
    }));
  },
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const status = values[0];
    if (typeof status === "string") state.leases.push(status);
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
        canContactPerson: async () => ({ allowed: true, destination: "lisa@example.com" }),
        classifyRetry: () => "permanent",
        nextCommunicationWindow: () => new Date(),
      };
      case "./tenantScope": return { currentTenantScope: () => ({ tenantId: "t1", system: false }) };
      case "./tenantBrand": return { DEFAULT_BRAND: { displayName: "Denago" }, brandForTenant: async () => ({ displayName: "Denago" }) };
      case "./tenantOrigin": return { tenantOrigin: async () => "https://crm.example" };
      case "./signing/signingEmail": return {
        tenantEmailContent: async (kind: string, _t: string, vars: Record<string, string>) => ({ subject: `[${kind}] ${vars.survey_title}`, text: `${kind}: ${vars.survey_link}`, html: "<p/>" }),
        tenantSmsContent: async (kind: string) => kind,
      };
      case "./automationSwitch": return { automationOn: async (key: string) => (key === "SURVEY_AUTO_REMINDERS" ? state.switchOn : false) };
    }
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const require_ = createRequire(import.meta.url);
const { sendDueReminders } = require_("../src/lib/surveyDistributionQueue.ts") as typeof import("../src/lib/surveyDistributionQueue");

beforeEach(() => {
  state.switchOn = false;
  state.rows = [];
  state.claimed = [];
  state.sent = [];
  state.leases = [];
});

test("automatic survey created with a reminder, then the switch turned OFF → no reminder claimed or sent", async () => {
  state.rows = [{ id: "auto1", source: "automation_trigger", maxReminders: 1, reminderCount: 0 }];
  state.switchOn = false;
  assert.equal(await sendDueReminders("t1"), 0);
  assert.deepEqual(state.claimed, []);
  assert.deepEqual(state.sent, []);
});

test("the same automatic survey with the switch ON → the reminder goes, in the editable reminder template", async () => {
  state.rows = [{ id: "auto1", source: "automation_trigger", maxReminders: 1, reminderCount: 0 }];
  state.switchOn = true;
  assert.equal(await sendDueReminders("t1"), 1);
  assert.equal(state.sent.length, 1);
  assert.match(state.sent[0].subject ?? "", /^\[survey_reminder\]/, "Settings → Email templates → Survey reminder");
  assert.match(state.sent[0].text, /https:\/\/crm\.example\/s\/tok_auto1/);
});

test("a distribution a PERSON created keeps its own reminder setting, whatever the automatic switch says", async () => {
  state.rows = [{ id: "manual1", source: "distribution", maxReminders: 1, reminderCount: 0 }, { id: "manual2", source: null, maxReminders: 2, reminderCount: 1 }];
  state.switchOn = false;
  assert.equal(await sendDueReminders("t1"), 2);
  assert.deepEqual(state.claimed.sort(), ["manual1", "manual2"]);
  // …and one with no reminders set gets none.
  state.rows = [{ id: "manual3", source: "distribution", maxReminders: 0, reminderCount: 0 }];
  state.sent = [];
  assert.equal(await sendDueReminders("t1"), 0);
  assert.deepEqual(state.sent, []);
});
