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
  // The whole claim is carried now, not just its row id: the flow transaction
  // settles the lease itself, and that needs the generation as well.
  assert.match(helper, /inboundEventContext\.run\(\{ claim \}, fn\)/);
  assert.match(helper, /export async function completeInboundBotEventTx/);
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
  // Existing rows are events already accepted before this rollout, so they must
  // land as `completed` rather than becoming replayable provider ids.
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'completed'/);
  assert.match(migration, /UPDATE "BotInboundEvent"/);
  assert.match(migration, /ALTER COLUMN "status" SET DEFAULT 'running'/);

  // And every statement must be reentrant. 20260809144000 exists as two different
  // files under one directory name across this stack — the lower branches create
  // BotInboundEvent WITH these columns, the upper ones rely on this migration to
  // add them. A bare ADD COLUMN is 42701 on half the merge orders, and the
  // migration runner opens no transaction, so a half-applied file is re-run from
  // the top on the next deploy.
  // Scan the SQL only — the comment above explains the hazard and naturally
  // contains the very phrases being looked for.
  const sql = migration.replace(/^\s*--.*$/gm, "");
  const unguarded = sql.match(/ADD COLUMN(?! IF NOT EXISTS)|CREATE INDEX(?! IF NOT EXISTS)/g) ?? [];
  assert.deepEqual(unguarded, [], "every ADD COLUMN / CREATE INDEX here must be guarded");
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
    // Raised through noteInboundRetry so the reason is recorded WHILE the tenant
    // scope that owns it is still entered; at the outer catch it would file
    // unattributed and the workspace's System Log excludes those.
    assert.match(code, /if \(outcome\.status === "leased"\) throw await note(LeasedInbound|InboundRetry)\(/);
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

test("the lead identity constraint and the lookup that consults it share one domain", () => {
  const creator = src("src/lib/leadCreate.ts");
  // The row must carry a tenant. The db.ts guard only stamps one under enforcement,
  // which is dormant, so without this the row lands NULL while the identity read
  // asks for DEFAULT_TENANT_ID — and the pre-check never matches what it created.
  assert.match(creator, /tenantId: writeTenantId\(\) \?\? DEFAULT_TENANT_ID/);
  const recovery = creator.slice(creator.indexOf('error.code === "P2002"'));
  assert.match(recovery, /no longer agree/);

  // The constraint is scoped to the tenant, matching existingExternalLead().
  const schema = src("prisma/schema.prisma");
  assert.match(schema, /@@unique\(\[tenantId, externalId\]\)/);
  assert.doesNotMatch(schema, /externalId String\? @unique/);

  const migration = src("prisma/migrations/20260809200000_lead_external_id_tenant_scope/migration.sql");
  assert.match(migration, /UPDATE "Lead" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL/);
  assert.match(migration, /DROP INDEX IF EXISTS "Lead_externalId_key"/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "Lead_tenantId_externalId_key"/);
});

test("the provider event is acknowledged in the same transaction as the graph move", () => {
  // Completing it AFTER the flow transaction committed left a window that
  // corrupts conversation state rather than merely duplicating an effect: the
  // session and outbox commit, the process dies, the lease expires, and the
  // redelivery replays the old message against an ALREADY-ADVANCED graph — the
  // customer's phone number read as their answer to "what service do you need?".
  // CRM action idempotency cannot help; the damage is in the graph position.
  for (const rel of ["src/lib/flowRun.ts", "src/lib/flowSession.ts"]) {
    const code = src(rel);
    const tx = code.indexOf("await withBotConversationWrite(async (tx, tenantId)");
    const complete = code.indexOf("completeInboundBotEventTx(tx, tenantId", tx);
    const session = code.indexOf("upsertBotSessionTx(tx, tenantId", tx);
    assert.ok(tx >= 0, `${rel}: must open a tenant write transaction`);
    assert.ok(complete > tx, `${rel}: the event must be completed INSIDE that transaction`);
    assert.ok(session > tx, `${rel}: and the session written in it too`);
    // Before the branches, or the session/handoff paths return early and skip it.
    assert.ok(complete < session, `${rel}: completion must not sit after an early return`);
  }
});
