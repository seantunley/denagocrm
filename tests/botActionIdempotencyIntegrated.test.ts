import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("leased inbound event identity reaches every provider chatbot path", () => {
  const helper = src("src/lib/botInboundEvent.ts");
  assert.match(helper, /new AsyncLocalStorage<InboundBotEventContext>/);
  assert.match(helper, /inboundEventContext\.run\(\{ eventId: claim\.rowId \}, fn\)/);
  for (const rel of [
    "src/app/api/webhooks/whatsapp/route.ts",
    "src/app/api/webhooks/meta/route.ts",
    "src/app/api/webhooks/telegram/route.ts",
  ]) {
    const code = src(rel);
    assert.match(code, /withInboundBotEvent\(claim, async \(\) =>/);
    assert.match(code, /completeInboundBotEvent\(claim\)/);
    assert.match(code, /retryInboundBotEvent\(claim, error\)/);
  }
});

test("side-effecting flow callbacks receive the executing node id", () => {
  const flow = src("src/lib/flow.ts");
  assert.match(flow, /handler\(slotId, vars, node\.id\)/);
  assert.match(flow, /ctx\.createBooking\(vars, node\.action, node\.id\)/);
  assert.match(flow, /ctx\.manageBooking\(node\.action, vars, node\.id\)/);
  assert.match(flow, /bookSlot\?: \(slotId: string, vars: Record<string, string>, nodeId: string\)/);
});

test("new CRM effects derive stable identities from inbound event plus node", () => {
  const actions = src("src/lib/flowActions.ts");
  assert.match(actions, /currentInboundBotEventId\(\)/);
  assert.match(actions, /`bot:\$\{eventId\}:\$\{nodeId\}:\$\{kind\}`/);
  assert.match(actions, /externalId: key/);
  assert.match(actions, /externalId: botActionKey\(nodeId, "lead"\)/);
  assert.match(actions, /dedupeMarker: marker/);
  assert.doesNotMatch(actions, /createIntakeLead\([\s\S]{0,400}\)\.catch\(\(\) => \{\}\)/);
});

test("external lead ids return the existing tenant-owned effect on retry/race", () => {
  const creator = src("src/lib/leadCreate.ts");
  assert.match(creator, /existingExternalLead/);
  assert.match(creator, /basePrisma\.lead\.findFirst\(\{ where: \{ tenantId, externalId \} \}\)/);
  assert.match(creator, /error\.code === "P2002"/);
  assert.match(creator, /if \(existing\) return existing/);
});

test("slot retry marker is checked before capacity is consumed", () => {
  const slots = src("src/lib/bookingSlots.ts");
  const lookup = slots.indexOf("if (input.dedupeMarker)");
  const capacity = slots.indexOf("await claimSlotCapacity", lookup);
  assert.ok(lookup >= 0 && capacity > lookup);
  assert.match(slots, /note: \{ contains: input\.dedupeMarker \}/);
});

test("inbound ledger migration preserves old accepted events as completed", () => {
  const migration = src("prisma/migrations/20260809172000_bot_inbound_event_leases/migration.sql");
  assert.match(migration, /ADD COLUMN "status" TEXT NOT NULL DEFAULT 'completed'/);
  assert.match(migration, /UPDATE "BotInboundEvent"/);
  assert.match(migration, /ALTER COLUMN "status" SET DEFAULT 'running'/);
});
