import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deliveryEveText, tomorrowWindow } from "../src/lib/deliveryEveRules";
import { PROACTIVE_KINDS, proactivePush, proactiveQuestion, proactiveText } from "../src/lib/proactiveRules";
import type { GoalFacts } from "../src/lib/assistantGoalRules";

const code = (path: string) => readFileSync(path, "utf8");
const facts = (over: Partial<GoalFacts> = {}): GoalFacts => ({
  ref: "Q-1042", depositPaid: true, invoiced: true, stock: [{ pdiStatus: "passed" }],
  deliveryScheduledFor: new Date("2026-11-03T08:00:00Z"), delivered: false, lost: false, ...over,
});

test("tomorrow is the next Johannesburg calendar day, whatever the hour", () => {
  for (const at of ["2026-11-02T06:00:00Z", "2026-11-02T21:30:00Z"]) {
    const { gte, lt } = tomorrowWindow(new Date(at));
    assert.equal(gte.toISOString(), "2026-11-02T22:00:00.000Z", at);
    assert.equal(lt.toISOString(), "2026-11-03T22:00:00.000Z", at);
  }
});

test("all done: every check ticked, and 'All set'", () => {
  const text = deliveryEveText(facts(), "Anna Smith", "https://crm.example.com/");
  assert.match(text, /^🚚 Tomorrow's delivery: Q-1042 for Anna Smith/);
  assert.match(text, /✅ Deposit paid\n✅ Invoice issued\n✅ Cart allocated and PDI passed/);
  assert.match(text, /All set\./);
  assert.match(text, /Nothing has been sent to the customer/);
});

test("anything missing: what to do and the screen's link — and no promise to contact the customer", () => {
  const text = deliveryEveText(facts({ depositPaid: false, stock: [{ pdiStatus: "pending" }] }), "Anna Smith", "https://crm.example.com");
  assert.match(text, /❌ Deposit paid — not yet\. .*I won't contact them.* https:\/\/crm\.example\.com\/deliveries/);
  assert.match(text, /✅ Invoice issued/);
  assert.match(text, /❌ Cart allocated and PDI passed — not yet\. .* https:\/\/crm\.example\.com\/stock/);
  assert.doesNotMatch(text, /All set/);
  // No cart at all is missing too.
  assert.match(deliveryEveText(facts({ stock: [] }), "A", ""), /❌ Cart allocated and PDI passed/);
});

test("a proactive kind of its own: its words, a lock-screen line naming nobody, its own heading", () => {
  assert.ok(PROACTIVE_KINDS.includes("delivery_eve"));
  const text = proactiveText({ kind: "delivery_eve", customer: "Anna", url: "/deals/q1", detail: "🚚 check", recordKey: "q1:x" }, "https://crm.example.com");
  assert.equal(text, "🚚 check\nhttps://crm.example.com/deals/q1");
  assert.doesNotMatch(proactivePush("delivery_eve"), /Anna/);
  assert.equal(proactiveQuestion("delivery_eve"), "Tomorrow's delivery");
});

test("the run: proactive DAX's switches, the workspace's own scope, quiet hours, deliveries module — and once per booked day", () => {
  const run = code("src/lib/deliveryEve.ts");
  assert.match(run, /scope\.system \|\| scope\.tenantId !== tenantId\) return 0/);
  assert.match(run, /proactiveOn\(await setting\(tenantId, ASSISTANT_PROACTIVE_KEY\)\) \|\| isQuietHour\(now\)\) return 0/);
  assert.match(run, /isModuleEnabled\("automotive"\)/);
  assert.match(run, /status: "accepted", deletedAt: null, supersededAt: null, deliveredAt: null, deliveryScheduledFor: tomorrow/);
  // Through notifyCustomerActivity → raise: the person's own switch, their access to the deal, the unique key.
  assert.match(run, /notifyCustomerActivity\(/);
  assert.match(run, /recordKey: `\$\{q\.id\}:\$\{loaded\.facts\.deliveryScheduledFor\.toISOString\(\)\}`/);
  assert.doesNotMatch(run, /sendWhatsApp|sendEmail|sendSms/, "never the customer");
  assert.match(code("src/app/api/cron/assistant/route.ts"), /await runDeliveryEve\(tenantId, budget\)/);
});
