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

  const leadBranchStart = actions.indexOf('if (action === "lead")');
  const serviceBranchStart = actions.indexOf("const userId = await firstUserId()", leadBranchStart);
  assert.ok(leadBranchStart >= 0 && serviceBranchStart > leadBranchStart, "could not isolate the lead action branch");
  const leadBranch = actions.slice(leadBranchStart, serviceBranchStart);
  assert.match(leadBranch, /await createIntakeLead\(/);
  assert.doesNotMatch(leadBranch, /\.catch\(\(\) => \{\}\)/, "lead creation failures must remain retryable");
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

/* ── the guarantees this PR adds must not be silently skippable ──────────── */

test("the claim distinguishes a finished event from one another attempt still holds", () => {
  const helper = src("src/lib/botInboundEvent.ts");
  assert.match(helper, /status: "claimed"/);
  assert.match(helper, /status: "completed"/);
  assert.match(helper, /status: "leased"/);
  assert.match(helper, /status: "unidentified"/);
  assert.match(helper, /SELECT "status" FROM "BotInboundEvent"/);
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
    assert.match(code, /if \(outcome\.status === "leased"\) throw new InboundBotEventLeasedError\(/);
    // An event with no id makes actionKey() null, which disables every effect
    // marker at once — refuse it rather than run the flow unfenced.
    assert.match(code, /outcome\.status === "unidentified"/);
    assert.doesNotMatch(code, /if \(!claim\) (continue|return)/);
  }
});

test("a Contact is only created when something durable can match it on retry", () => {
  const actions = src("src/lib/flowActions.ts");
  const helper = actions.slice(actions.indexOf("async function ensureContact"));
  assert.match(helper, /if \(!identity\.length\) return match/);
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

test("the lead identity constraint and the lookup that consults it share one domain", () => {
  const creator = src("src/lib/leadCreate.ts");
  assert.match(creator, /tenantId: writeTenantId\(\) \?\? DEFAULT_TENANT_ID/);
  assert.match(creator.slice(creator.indexOf('error.code === "P2002"')), /no longer agree/);
  const schema = src("prisma/schema.prisma");
  assert.match(schema, /@@unique\(\[tenantId, externalId\]\)/);
  assert.doesNotMatch(schema, /externalId String\? @unique/);
  const migration = src("prisma/migrations/20260809200000_lead_external_id_tenant_scope/migration.sql");
  assert.match(migration, /UPDATE "Lead" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "Lead_tenantId_externalId_key"/);
});
