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

test("inbound event lease completion is fenced by its claim generation", () => {
  const helper = src("src/lib/botInboundEvent.ts");
  assert.match(helper, /leaseAttempt: number \| null/);
  assert.match(helper, /RETURNING "id", "attempts"/);
  assert.match(helper, /leaseAttempt: rows\[0\]\.attempts/);
  assert.match(helper, /where: \{ id: rowId, tenantId, status: "running", attempts: leaseAttempt \}/);
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

/* ── a live lease is not the same answer as a finished event ─────────────── */

test("the claim distinguishes a finished event from one another attempt still holds", () => {
  const helper = src("src/lib/botInboundEvent.ts");
  // Both mean "do not process", but only one may be acked.
  assert.match(helper, /status: "claimed"/);
  assert.match(helper, /status: "completed"/);
  assert.match(helper, /status: "leased"/);
  assert.match(helper, /status: "unidentified"/);
  // The second read is what tells them apart; without it the caller cannot.
  assert.match(helper, /SELECT "status" FROM "BotInboundEvent"/);
  assert.match(helper, /settled\[0\]\?\.status === "completed" \? \{ status: "completed" \} : \{ status: "leased" \}/);
  assert.match(helper, /class InboundBotEventLeasedError/);
});

test("every webhook acks a finished event and asks for redelivery of a leased one", () => {
  for (const rel of [
    "src/app/api/webhooks/whatsapp/route.ts",
    "src/app/api/webhooks/meta/route.ts",
    "src/app/api/webhooks/telegram/route.ts",
  ]) {
    const code = src(rel);
    assert.match(code, /outcome\.status === "completed"/);
    // Throwing is the point: a 2xx here retires the provider's redelivery and the
    // message is lost for good, because nothing sweeps an abandoned lease.
    assert.match(code, /if \(outcome\.status === "leased"\) throw new InboundBotEventLeasedError\(/);
    // An event with no stable id cannot produce a retry-safe action key, so it is
    // refused rather than run without idempotency.
    assert.match(code, /outcome\.status === "unidentified"/);
    assert.doesNotMatch(code, /if \(!claim\) (continue|return)/);
  }
});

/* ── effects that a retry must not duplicate ─────────────────────────────── */

test("a Contact is only created when something durable can match it on retry", () => {
  const actions = src("src/lib/flowActions.ts");
  const helper = actions.slice(actions.indexOf("async function ensureContact"));
  assert.match(helper, /if \(!identity\.length\) return match/);
  // The old guard let a bare name through, and a name is not something the reuse
  // lookup below can find, so every retry added another Contact.
  assert.doesNotMatch(helper, /if \(!\(vars\.name \|\| vars\.phone \|\| vars\.email\)\) return match/);
});

test("the slot retry marker is locked before it is read, not just before capacity", () => {
  const slots = src("src/lib/bookingSlots.ts");
  const guard = slots.indexOf("if (input.dedupeMarker)");
  const markerLock = slots.indexOf("bot-slot:", guard);
  const read = slots.indexOf("note: { contains: input.dedupeMarker }", guard);
  const capacity = slots.indexOf("await claimSlotCapacity", guard);
  assert.ok(guard >= 0 && markerLock > guard, "the marker must be locked inside the dedupe branch");
  assert.ok(markerLock < read, "the lock must be taken BEFORE the advisory marker read");
  assert.ok(read < capacity, "the marker is still checked before capacity is consumed");
});

test("a cross-tenant externalId collision is reported as permanent, not retried forever", () => {
  const creator = src("src/lib/leadCreate.ts");
  const recovery = creator.slice(creator.indexOf('error.code === "P2002"'));
  assert.match(recovery, /already belongs to a different tenant/);
  assert.match(recovery, /retrying will not change that/);
});
