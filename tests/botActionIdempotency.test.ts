import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("leased inbound event identity is carried in async context to CRM actions", () => {
  const helper = src("src/lib/botInboundEvent.ts");
  assert.match(helper, /new AsyncLocalStorage<InboundBotEventContext>/);
  assert.match(helper, /inboundEventContext\.run\(\{ eventId: claim\.rowId \}, fn\)/);
  assert.match(helper, /currentInboundBotEventId/);

  for (const rel of [
    "src/app/api/webhooks/whatsapp/route.ts",
    "src/app/api/webhooks/meta/route.ts",
    "src/app/api/webhooks/telegram/route.ts",
  ]) {
    assert.match(src(rel), /withInboundBotEvent\(claim, async \(\) =>/);
  }
});

test("side-effecting flow callbacks receive the exact node id", () => {
  const flow = src("src/lib/flow.ts");
  assert.match(flow, /ctx\.bookSlot\(slotId, vars, cur\.id\)/);
  assert.match(flow, /ctx\.createBooking\(vars, node\.action, node\.id\)/);
  assert.match(flow, /bookSlot\?: \(slotId: string, vars: Record<string, string>, nodeId: string\)/);
});

test("bot lead actions use stable external ids derived from event plus node", () => {
  const actions = src("src/lib/flowActions.ts");
  assert.match(actions, /currentInboundBotEventId\(\)/);
  assert.match(actions, /`bot:\$\{eventId\}:\$\{nodeId\}:\$\{kind\}`/);
  assert.match(actions, /externalId: key/);
  assert.doesNotMatch(actions, /createIntakeLead\([\s\S]*?\)\.catch\(\(\) => \{\}\)/);
});

test("the one lead creator treats externalId as a durable idempotency identity", () => {
  const creator = src("src/lib/leadCreate.ts");
  assert.match(creator, /existingExternalLead/);
  assert.match(creator, /basePrisma\.lead\.findFirst\(\{ where: \{ tenantId, externalId \} \}\)/);
  assert.match(creator, /error\.code === "P2002"/);
  assert.match(creator, /if \(existing\) return existing/);
});

test("service, demo and slot activities carry an action marker and check it on retry", () => {
  const actions = src("src/lib/flowActions.ts");
  assert.match(actions, /\[bot-action:\$\{digest\}\]/);
  assert.match(actions, /activityAlreadyExists\(marker\)/);
  assert.match(actions, /dedupeMarker: marker/);

  const slots = src("src/lib/bookingSlots.ts");
  const lookup = slots.indexOf("if (input.dedupeMarker)");
  const capacity = slots.indexOf("await claimSlotCapacity", lookup);
  assert.ok(lookup >= 0 && capacity > lookup, "retry lookup must happen before consuming slot capacity");
  assert.match(slots, /note: \{ contains: input\.dedupeMarker \}/);
});

test("provider event completion still happens only after the idempotent application work", () => {
  for (const rel of [
    "src/app/api/webhooks/whatsapp/route.ts",
    "src/app/api/webhooks/meta/route.ts",
    "src/app/api/webhooks/telegram/route.ts",
  ]) {
    const code = src(rel);
    const run = code.indexOf("withInboundBotEvent(claim");
    const complete = code.indexOf("completeInboundBotEvent(claim)", run);
    assert.ok(run >= 0 && complete > run, `${rel} must complete only after scoped work succeeds`);
  }
});
