import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("fresh and restarted one-shot flows emit explicit start and completion events", () => {
  for (const rel of ["src/lib/flowSession.ts", "src/lib/flowRun.ts"]) {
    const code = src(rel);
    assert.match(code, /runtime_one_shot/);
    assert.match(code, /eventType: "flow_started"/);
    assert.match(code, /eventType: "flow_completed"/);
    assert.match(code, /!result\.session && !result\.handedOff/);
  }
});

test("restart mutations mark their transaction so the BotSession trigger cannot count old-flow progression", () => {
  for (const rel of ["src/lib/flowSession.ts", "src/lib/flowRun.ts"]) {
    assert.match(src(rel), /set_config\('app\.bot_flow_transition', 'restart', true\)/);
  }
  const migration = src("prisma/migrations/20260809181500_bot_flow_restart_analytics/migration.sql");
  assert.match(migration, /transition_kind = 'restart'/);
  assert.match(migration, /IF transition_kind = 'restart' THEN RETURN OLD; END IF/);
  assert.match(migration, /'flow_started'/);
  assert.match(migration, /'node_waiting'/);
});

test("successful CRM and Journey effects emit node-level crm_action analytics", () => {
  const flow = src("src/lib/flow.ts");
  assert.match(flow, /recordAction\?:/);
  assert.match(flow, /ctx\.recordAction\?\.\(node\.id, "journey_start", outcome\.ok\)/);
  // Every booking action now reports its REAL outcome, not a hard-coded true.
  // createBooking used to return void, so a demo request that created nothing —
  // no actor, or no pipeline stage — was recorded as a successful crm_action and
  // the customer was told it had been sent.
  assert.match(flow, /ctx\.recordAction\?\.\(node\.id, `booking_\$\{node\.action\}`, outcome\.ok\)/);
  assert.match(flow, /ctx\.recordAction\?\.\(node\.id, `booking_\$\{node\.action \?\? "service"\}`, outcome\.ok\)/);
  assert.doesNotMatch(flow, /recordAction\?\.\([^)]*, true\)/, "no action may be recorded as successful unconditionally");
  assert.match(flow, /ctx\.recordAction\?\.\(node\.id, action, res\.ok\)/);
  for (const rel of ["src/lib/flowSession.ts", "src/lib/flowRun.ts"]) assert.match(src(rel), /eventType: "crm_action"/);
});

test("outbox rows retain immutable flow-version attribution", () => {
  const schema = src("prisma/bot-outbox.prisma");
  assert.match(schema, /flowVersionId String\?/);
  const migration = src("prisma/migrations/20260809180500_bot_outbox_flow_version/migration.sql");
  assert.match(migration, /FOREIGN KEY \("flowVersionId"\) REFERENCES "BotFlowVersion"\("id"\)/);
  assert.match(migration, /ON DELETE SET NULL/);
  const writer = src("src/lib/botOutboxWrite.ts");
  assert.match(writer, /flowVersionId: input\.flowVersionId \?\? null/);
});

test("provider failure is recorded only when the durable message becomes terminally dead", () => {
  const outbox = src("src/lib/botOutbox.ts");
  // The terminal branch is reached by exhausting the retries OR by a failure
  // class that will fail identically every time; both end in the same place.
  const deadAt = outbox.indexOf("if (row.attempts >= MAX_ATTEMPTS ||");
  const recordAt = outbox.indexOf("eventType: \"delivery_failed\"", deadAt);
  const retryAt = outbox.indexOf("status: \"retry\"", deadAt);
  assert.ok(deadAt >= 0 && recordAt > deadAt && retryAt > recordAt);
  assert.match(outbox, /row\.flowVersionId/);
});

test("WhatsApp escapes a BOT handoff on an explicit command, but never a staff takeover", () => {
  // This test used to assert `existing?.status === "paused" && !restart`, which is
  // the defect: `paused` meant both "the bot handed off" and "a person took this
  // over", and the restart set included greetings. A customer saying "hi" to the
  // salesperson helping them restarted the flow on top of that person.
  const code = src("src/lib/flowRun.ts");
  assert.match(code, /decideInboundAct\(/, "WhatsApp must use the shared ownership rule");
  assert.doesNotMatch(code, /status === "paused" && !restart/, "status alone cannot decide this");
  // The behaviour itself is proven in botOwnership.test.ts, against the rule
  // rather than against the source of the runner that calls it.
});

test("flow-start and node-reach denominators count explicit events rather than distinct participant ids", () => {
  const aggregate = src("src/lib/botFlowAnalytics.ts");
  const report = src("src/lib/botFlowAnalyticsReport.ts");
  assert.doesNotMatch(aggregate, /COUNT\(DISTINCT "conversationKey"\) FILTER \(WHERE "eventType" = 'flow_started'\)/);
  assert.doesNotMatch(aggregate, /COUNT\(DISTINCT "conversationKey"\) FILTER \(WHERE "eventType" = 'node_waiting'\)/);
  assert.doesNotMatch(report, /COUNT\(DISTINCT "conversationKey"\) FILTER \(WHERE "eventType" = 'flow_started'\)/);
  assert.match(aggregate, /COUNT\(\*\) FILTER \(WHERE "eventType" = 'flow_started'\)/);
  assert.match(aggregate, /COUNT\(\*\) FILTER \(WHERE "eventType" = 'node_waiting'\)/);
  assert.match(report, /COUNT\(\*\) FILTER \(WHERE "eventType" = 'flow_started'\)/);
});

test("analytics report surfaces one-shot semantics, CRM actions and terminal delivery failures", () => {
  const page = src("src/app/(app)/bot-analytics/page.tsx");
  assert.match(page, />CRM actions</);
  assert.match(page, /node\.crmActions/);
  assert.match(page, /node\.deliveryFailures/);
  assert.match(page, /Run totals include both stateful guided conversations and automatic one-shot graphs/);
  assert.doesNotMatch(page, /intentionally not counted/);
});

test("Journey nodes retain a meaningful immutable analytics label", () => {
  const report = src("src/lib/botFlowAnalyticsReport.ts");
  assert.match(report, /node\.type === "journey"/);
  assert.match(report, /Journey: \$\{node\.journeyId\}/);
});

test("final stack retains the approved simulator detail shell", () => {
  const simulatorPage = src("src/app/(app)/bot-builder/[id]/test/page.tsx");
  assert.match(simulatorPage, /EntityDetailShell/);
  assert.match(simulatorPage, /backHref=\{`\/bot-builder\/\$\{id\}`\}/);
});
