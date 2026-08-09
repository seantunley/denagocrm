import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  decideChannelScope,
  type ChannelResolution,
  type ChannelScopeAction,
} from "../src/lib/channelScopeDecision";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";

/**
 * Inbound-channel tenancy (WhatsApp / Messenger / Instagram webhooks).
 *
 * `withChannelTenantScope` used to open with `if (!tenantEnforcing()) return fn()`,
 * so with enforcement off — production, for the foreseeable future — the endpoint id
 * in the payload was never looked up. The only authentication on those routes is one
 * install-global `META_APP_SECRET` HMAC, which EVERY tenant subscribed to the same
 * Meta app shares. A second tenant's number/Page therefore ran with no tenant scope:
 * its conversations, contacts, leads and bot sessions were filed under the FOUNDING
 * tenant (helpers stamp `writeTenantId() ?? DEFAULT_TENANT_ID`) and its replies went
 * out from the founding tenant's credentials.
 *
 * The fix resolves in EVERY mode but keeps dormant mode PERMISSIVE on a miss, because
 * an empty `ChannelIdentity` is the normal state of an existing single-tenant install
 * (the map is filled by a manual pre-enforcement backfill). Failing closed there would
 * break every inbound message on deploy.
 *
 * These tests EXECUTE that decision rather than grepping the source for it: the rule
 * lives in the import-free `src/lib/channelScopeDecision.ts`, and the scenario below
 * plays real webhook batches through the same dispatch `withChannelTenantScope` does.
 */

const RESOLVED = (tenantId: string): ChannelResolution => ({ status: "resolved", tenantId });
const UNMAPPED: ChannelResolution = { status: "unmapped" };
const FAILED: ChannelResolution = { status: "failed" };

const ENFORCING = true;
const DORMANT = false;

const TENANT_B = "tenant_second_dealer";

// ── The 2×2 that is the whole point ────────────────────────────────────────────

test("enforcing × resolved → runs inside the resolved tenant's scope", () => {
  const action = decideChannelScope(ENFORCING, RESOLVED(TENANT_B));
  assert.deepEqual(action, { run: "scoped", tenantId: TENANT_B });
});

test("enforcing × unresolved → the event is SKIPPED (fail closed, unchanged)", () => {
  const action = decideChannelScope(ENFORCING, UNMAPPED);
  assert.deepEqual(action, { run: "unresolved" });
});

test("dormant × resolved → STILL runs inside the resolved tenant's scope (the fix)", () => {
  const action = decideChannelScope(DORMANT, RESOLVED(TENANT_B));
  assert.deepEqual(
    action,
    { run: "scoped", tenantId: TENANT_B },
    "a mapped endpoint must be scoped even with enforcement off — otherwise a second tenant's inbound traffic is filed under the founding tenant",
  );
});

test("dormant × unresolved → runs UNSCOPED, exactly as before (no outage on deploy)", () => {
  const action = decideChannelScope(DORMANT, UNMAPPED);
  assert.deepEqual(
    action,
    { run: "unscoped" },
    "an unmapped endpoint with enforcement off is the NORMAL state of a single-tenant install; rejecting it would break every inbound message",
  );
  assert.notEqual(action.run, "unresolved", "dormant must never fail closed on a miss");
});

// A lookup that THREW is not a miss, and must not be collapsed into one.

test("dormant × lookup FAILURE → degrades to unscoped (a DB blip cannot break the webhook)", () => {
  assert.deepEqual(decideChannelScope(DORMANT, FAILED), { run: "unscoped" });
});

test("enforcing × lookup FAILURE → re-throws, so the delivery is retried not dropped", () => {
  assert.deepEqual(decideChannelScope(ENFORCING, FAILED), { run: "rethrow" });
});

// The decision must depend ONLY on (mode, resolution) — never leak an id it wasn't given.
test("a scoped decision carries exactly the resolved tenant id", () => {
  for (const tenantId of [DEFAULT_TENANT_ID, TENANT_B, "tenant_third"]) {
    for (const enforcing of [ENFORCING, DORMANT]) {
      const action = decideChannelScope(enforcing, RESOLVED(tenantId));
      assert.equal(action.run, "scoped");
      assert.equal(action.run === "scoped" ? action.tenantId : null, tenantId);
    }
  }
});

// ── Scenario: play a webhook batch through the real dispatch ───────────────────

type InboundEvent = { channel: string; endpoint: string; body: string };
type FiledRow = { tenantId: string; body: string };

/**
 * The dispatch `withChannelTenantScope` performs, with the DB replaced by a map and
 * the tenant scope by a variable. `runInTenantScope` → the row is filed under that
 * tenant; running unscoped → downstream helpers stamp `writeTenantId() ?? DEFAULT_
 * TENANT_ID`, i.e. the FOUNDING tenant, which is precisely the bug being fixed.
 */
function deliverBatch(
  enforcing: boolean,
  channelIdentities: Map<string, string>,
  events: InboundEvent[],
  opts: { lookupThrows?: boolean } = {},
): { filed: FiledRow[]; skipped: InboundEvent[]; errors: unknown[] } {
  const filed: FiledRow[] = [];
  const skipped: InboundEvent[] = [];
  const errors: unknown[] = [];

  for (const event of events) {
    let resolution: ChannelResolution;
    let lookupError: unknown;
    try {
      if (opts.lookupThrows) throw new Error('relation "ChannelIdentity" does not exist');
      const tenantId = channelIdentities.get(`${event.channel}:${event.endpoint}`);
      resolution = tenantId ? { status: "resolved", tenantId } : { status: "unmapped" };
    } catch (error) {
      lookupError = error;
      resolution = { status: "failed" };
    }

    const decision: ChannelScopeAction = decideChannelScope(enforcing, resolution);
    if (decision.run === "rethrow") errors.push(lookupError);
    else if (decision.run === "unresolved") skipped.push(event);
    else if (decision.run === "unscoped") filed.push({ tenantId: DEFAULT_TENANT_ID, body: event.body });
    else filed.push({ tenantId: decision.tenantId, body: event.body });
  }

  return { filed, skipped, errors };
}

// The endpoint→tenant map an install has AFTER scripts/backfill-channel-identities.ts
// has been run for two tenants sharing one Meta app.
const MAPPED = new Map<string, string>([
  ["whatsapp:1111111111", DEFAULT_TENANT_ID],
  ["whatsapp:2222222222", TENANT_B],
  ["messenger:page_b", TENANT_B],
]);

const BATCH: InboundEvent[] = [
  { channel: "whatsapp", endpoint: "1111111111", body: "founding tenant customer" },
  { channel: "whatsapp", endpoint: "2222222222", body: "second tenant customer" },
  { channel: "messenger", endpoint: "page_b", body: "second tenant DM" },
];

test("scenario: with enforcement OFF, a mapped second tenant's traffic is filed under IT, not the founding tenant", () => {
  const { filed, skipped, errors } = deliverBatch(DORMANT, MAPPED, BATCH);

  assert.equal(skipped.length, 0, "nothing may be dropped while dormant");
  assert.equal(errors.length, 0);
  assert.deepEqual(filed, [
    { tenantId: DEFAULT_TENANT_ID, body: "founding tenant customer" },
    { tenantId: TENANT_B, body: "second tenant customer" },
    { tenantId: TENANT_B, body: "second tenant DM" },
  ]);

  const leaked = filed.filter((row) => row.tenantId === DEFAULT_TENANT_ID).map((row) => row.body);
  assert.deepEqual(
    leaked,
    ["founding tenant customer"],
    "the pre-fix behaviour filed EVERY row under the founding tenant",
  );
});

test("scenario: an install that never ran the backfill keeps working untouched while dormant", () => {
  const { filed, skipped, errors } = deliverBatch(DORMANT, new Map(), BATCH);

  assert.equal(skipped.length, 0, "an unmapped install must not start dropping inbound messages");
  assert.equal(errors.length, 0);
  assert.equal(filed.length, BATCH.length, "every event still processes");
  assert.ok(
    filed.every((row) => row.tenantId === DEFAULT_TENANT_ID),
    "…under the founding tenant, byte-for-byte the pre-tenancy path",
  );
});

test("scenario: a broken ChannelIdentity lookup does not take the webhook down while dormant", () => {
  const { filed, skipped, errors } = deliverBatch(DORMANT, MAPPED, BATCH, { lookupThrows: true });

  assert.equal(errors.length, 0, "dormant must swallow a lookup failure — it did no query at all before");
  assert.equal(skipped.length, 0);
  assert.equal(filed.length, BATCH.length);
});

test("scenario: with enforcement ON, unmapped endpoints are skipped and mapped ones stay isolated", () => {
  const partial = new Map<string, string>([["whatsapp:2222222222", TENANT_B]]);
  const { filed, skipped } = deliverBatch(ENFORCING, partial, BATCH);

  assert.deepEqual(filed, [{ tenantId: TENANT_B, body: "second tenant customer" }]);
  assert.deepEqual(
    skipped.map((event) => event.body),
    ["founding tenant customer", "second tenant DM"],
    "under enforcement an unmapped endpoint is skipped, never processed unscoped",
  );
});

test("scenario: under enforcement a lookup failure surfaces instead of silently dropping events", () => {
  const { filed, skipped, errors } = deliverBatch(ENFORCING, MAPPED, BATCH, { lookupThrows: true });

  assert.equal(filed.length, 0, "nothing may be processed when we could not determine the tenant");
  assert.equal(skipped.length, 0, "…and it must not be quietly recorded as an unmapped miss");
  assert.equal(errors.length, BATCH.length, "the error propagates so Meta redelivers");
});

// ── Anti-divergence: the real helper must route through this rule ──────────────
//
// The scenario above executes the POLICY; this pins the CALL SITE to it, so the
// helper cannot quietly regrow the dormant early-return the tests no longer see.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entrySource = readFileSync(path.join(root, "src/lib/tenantScopeEntry.ts"), "utf8");

test("withChannelTenantScope routes through decideChannelScope", () => {
  const body = entrySource.slice(entrySource.indexOf("export async function withChannelTenantScope"));
  assert.ok(body.length > 0, "withChannelTenantScope must exist");
  assert.match(body, /decideChannelScope\(\s*tenantEnforcing\(\)\s*,/, "the mode must be handed to the shared rule");
  assert.match(body, /resolveChannelTenant\(/, "the endpoint must be resolved");
  assert.match(entrySource, /from "\.\/channelScopeDecision"/, "must import the shared rule");
});

test("withChannelTenantScope does NOT short-circuit on tenantEnforcing() before resolving", () => {
  const body = entrySource.slice(entrySource.indexOf("export async function withChannelTenantScope"));
  const resolveAt = body.indexOf("resolveChannelTenant(");
  const shortCircuit = body.search(/if\s*\(\s*!\s*tenantEnforcing\(\)\s*\)/);
  assert.ok(resolveAt > 0, "must call resolveChannelTenant");
  assert.ok(
    shortCircuit === -1 || shortCircuit > resolveAt,
    "the dormant early-return is the bug: with enforcement off the endpoint id was never looked up at all",
  );
});
