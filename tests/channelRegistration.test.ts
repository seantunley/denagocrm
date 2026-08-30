import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  keyNamesAnInboundEndpoint,
  metaEndpointsFrom,
  registerChannelEndpoints,
  retireEndpoints,
  whatsappEndpointFrom,
  type ChannelIdentityStore,
  type ExistingIdentity,
  type RegistrationOutcome,
} from "../src/lib/channelEndpoints";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/**
 * `ChannelIdentity` decides whether an inbound webhook is filed or discarded,
 * and under enforcement an unregistered endpoint is dropped in silence. These
 * tests cover the two halves of that: that a stored credential registers its
 * endpoint, and that registering NEVER takes an endpoint from another tenant.
 */

// ── The store double ────────────────────────────────────────────────────────
//
// It applies no policy of its own: it returns exactly what it was seeded with
// and records every write. So a version of registerChannelEndpoints that
// stopped checking ownership would steal the row here and fail the assertions,
// rather than being quietly saved by a helpful fake.

type Call = { op: "find" | "create" | "update" | "disable" | "claim"; channel: string; externalId: string; data?: unknown };

function fakeStore(seed: Record<string, ExistingIdentity> = {}, opts: { failCreateOnce?: boolean } = {}) {
  const rows = new Map(Object.entries(seed));
  const calls: Call[] = [];
  let createsAttempted = 0;

  const store: ChannelIdentityStore = {
    async find(channel, externalId) {
      calls.push({ op: "find", channel, externalId });
      return rows.get(`${channel}:${externalId}`) ?? null;
    },
    async create(row) {
      createsAttempted += 1;
      calls.push({ op: "create", channel: row.channel, externalId: row.externalId, data: row });
      if (opts.failCreateOnce && createsAttempted === 1) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      rows.set(`${row.channel}:${row.externalId}`, {
        tenantId: row.tenantId,
        disabledAt: null,
        label: row.label,
      });
    },
    async update(channel, externalId, data, tenantId) {
      calls.push({ op: "update", channel, externalId, data });
      const existing = rows.get(`${channel}:${externalId}`);
      if (!existing) throw new Error("update of a row that does not exist");
      // The real store filters on tenantId, so this one does too. A `updateMany`
      // whose predicate stopped naming the tenant would edit another workspace's
      // row in production; here it silently matches nothing, exactly as it would
      // there — so the assertion that the row is unchanged still catches it.
      if (existing.tenantId !== tenantId) return;
      rows.set(`${channel}:${externalId}`, {
        tenantId: existing.tenantId,
        disabledAt: "disabledAt" in data ? null : existing.disabledAt,
        label: data.label ?? existing.label,
      });
    },
    async listForTenant(tenantId, channels) {
      const wanted = new Set(channels);
      return [...rows.entries()]
        .filter(([key, row]) => {
          const channel = key.split(":")[0];
          return row.tenantId === tenantId && row.disabledAt === null && wanted.has(channel as never);
        })
        .map(([key]) => {
          const [channel, externalId] = key.split(":");
          return { channel: channel as never, externalId };
        });
    },
    async disable(channel, externalId, tenantId) {
      calls.push({ op: "disable", channel, externalId });
      const existing = rows.get(`${channel}:${externalId}`);
      if (!existing || existing.tenantId !== tenantId) return;
      rows.set(`${channel}:${externalId}`, { ...existing, disabledAt: new Date("2026-08-30") });
    },
    async claim(channel, externalId, tenantId, label) {
      calls.push({ op: "claim", channel, externalId });
      const existing = rows.get(`${channel}:${externalId}`);
      // The real store guards on `disabledAt IS NOT NULL` inside the write, so
      // this one does too. An implementation that dropped that guard would take
      // a LIVE endpoint from another tenant here as well, and the assertions
      // would catch it.
      if (!existing || existing.disabledAt === null) return false;
      rows.set(`${channel}:${externalId}`, {
        tenantId,
        disabledAt: null,
        label: label ?? existing.label,
      });
      return true;
    },
  };

  return {
    store,
    calls,
    rows,
    writes: () => calls.filter((c) => c.op !== "find"),
  };
}

const WA = { channel: "whatsapp" as const, externalId: "1267798526410379", label: null };

// ── Deriving endpoints from credentials ─────────────────────────────────────

test("the WhatsApp phone-number id IS the endpoint — no provider call needed", () => {
  const endpoint = whatsappEndpointFrom("1267798526410379");
  assert.deepEqual(endpoint, { channel: "whatsapp", externalId: "1267798526410379", label: null });
});

test("a blank or missing WhatsApp phone-number id registers nothing", () => {
  assert.equal(whatsappEndpointFrom(""), null);
  assert.equal(whatsappEndpointFrom("   "), null);
  assert.equal(whatsappEndpointFrom(null), null);
  assert.equal(whatsappEndpointFrom(undefined), null);
});

test("a pasted phone-number id is trimmed, because a stray space is a different endpoint", () => {
  assert.equal(whatsappEndpointFrom("  1267798526410379 \n")?.externalId, "1267798526410379");
});

test("a Meta page token yields both the Page and its Instagram account", async () => {
  const discovery = await metaEndpointsFrom("EAAtoken", {
    fetch: (async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "993949857137664",
              name: "Denago Cape Town",
              instagram_business_account: { id: "17841446988337480", username: "denago_capetown" },
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch,
  });

  assert.deepEqual(discovery, {
    ok: true,
    endpoints: [
      { channel: "messenger", externalId: "993949857137664", label: "Denago Cape Town" },
      { channel: "instagram", externalId: "17841446988337480", label: "@denago_capetown" },
    ],
  });
});

test("a Page with no linked Instagram account yields only the Page", async () => {
  const discovery = await metaEndpointsFrom("EAAtoken", {
    fetch: (async () =>
      new Response(JSON.stringify({ data: [{ id: "993949857137664", name: "Denago" }] }), { status: 200 })) as unknown as typeof fetch,
  });
  assert.equal(discovery.ok, true);
  assert.deepEqual(discovery.ok && discovery.endpoints.map((e) => e.channel), ["messenger"]);
});

test("Meta being unreachable is 'we do not know', NOT 'this tenant has none'", async () => {
  // The distinction is load-bearing: an empty array would let retirement wipe
  // every working Meta row on a transient outage.
  const rejecting = (async () => {
    throw new Error("ECONNRESET");
  }) as unknown as typeof fetch;
  assert.deepEqual(await metaEndpointsFrom("EAAtoken", { fetch: rejecting }), { ok: false });

  const refusing = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
  assert.deepEqual(await metaEndpointsFrom("EAAtoken", { fetch: refusing }), { ok: false });
});

test("no Meta token is an ANSWER — no endpoints, no Graph call, and retirement may act on it", async () => {
  let called = false;
  const spy = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  assert.deepEqual(await metaEndpointsFrom("", { fetch: spy }), { ok: true, endpoints: [] });
  assert.deepEqual(await metaEndpointsFrom(null, { fetch: spy }), { ok: true, endpoints: [] });
  assert.equal(called, false);
});

// ── Registration ────────────────────────────────────────────────────────────

test("an unregistered endpoint is claimed for the saving tenant", async () => {
  const f = fakeStore();
  const outcomes = await registerChannelEndpoints("tenant_a", [WA], { store: f.store });

  assert.deepEqual(outcomes, [{ channel: "whatsapp", externalId: WA.externalId, status: "registered" }]);
  assert.equal(f.rows.get(`whatsapp:${WA.externalId}`)?.tenantId, "tenant_a");
});

test("re-registering our own unchanged endpoint writes NOTHING — the cron sweep is a read", async () => {
  const f = fakeStore({ [`whatsapp:${WA.externalId}`]: { tenantId: "tenant_a", disabledAt: null, label: null } });
  const outcomes = await registerChannelEndpoints("tenant_a", [WA], { store: f.store });

  assert.equal(outcomes[0].status, "already_ours");
  assert.deepEqual(f.writes(), [], "a healthy install must not write on every cron tick");
});

test("a disabled endpoint of ours is re-enabled when the credential is saved again", async () => {
  const f = fakeStore({
    [`whatsapp:${WA.externalId}`]: { tenantId: "tenant_a", disabledAt: new Date("2026-08-01"), label: null },
  });
  const outcomes = await registerChannelEndpoints("tenant_a", [WA], { store: f.store });

  assert.equal(outcomes[0].status, "reenabled");
  assert.equal(f.rows.get(`whatsapp:${WA.externalId}`)?.disabledAt, null);
});

test("a label discovered later is filled in, without disturbing ownership", async () => {
  const f = fakeStore({ [`whatsapp:${WA.externalId}`]: { tenantId: "tenant_a", disabledAt: null, label: null } });
  await registerChannelEndpoints("tenant_a", [{ ...WA, label: "Denago EV · +27 63 336 3533" }], { store: f.store });

  const row = f.rows.get(`whatsapp:${WA.externalId}`);
  assert.equal(row?.label, "Denago EV · +27 63 336 3533");
  assert.equal(row?.tenantId, "tenant_a");
});

test("AN ENDPOINT ANOTHER TENANT HOLDS IS NEVER TAKEN", async () => {
  const f = fakeStore({ [`whatsapp:${WA.externalId}`]: { tenantId: "tenant_a", disabledAt: null, label: null } });
  const conflicts: RegistrationOutcome[] = [];

  const outcomes = await registerChannelEndpoints("tenant_b", [WA], {
    store: f.store,
    onConflict: (o) => { conflicts.push(o); },
  });

  assert.deepEqual(outcomes, [
    { channel: "whatsapp", externalId: WA.externalId, status: "claimed_by_another_tenant", ownedBy: "tenant_a" },
  ]);
  // The row is untouched: tenant_a keeps receiving its own messages.
  assert.deepEqual(f.writes(), [], "a contested endpoint must not be re-pointed");
  assert.equal(f.rows.get(`whatsapp:${WA.externalId}`)?.tenantId, "tenant_a");
  // And it is reported, not swallowed — one workspace is receiving nothing.
  assert.equal(conflicts.length, 1);
});

test("losing the create race to ourselves settles as already_ours, not an error", async () => {
  const f = fakeStore({}, { failCreateOnce: true });
  // The concurrent winner was this same tenant.
  f.rows.set(`whatsapp:${WA.externalId}`, { tenantId: "tenant_a", disabledAt: null, label: null });

  const outcomes = await registerChannelEndpoints("tenant_a", [WA], { store: f.store });
  assert.equal(outcomes[0].status, "already_ours");
});

test("losing the create race to another tenant is reported as a conflict, not swallowed", async () => {
  const f = fakeStore({}, { failCreateOnce: true });
  f.rows.set(`whatsapp:${WA.externalId}`, { tenantId: "tenant_other", disabledAt: null, label: null });

  const conflicts: RegistrationOutcome[] = [];
  const outcomes = await registerChannelEndpoints("tenant_a", [WA], {
    store: f.store,
    onConflict: (o) => { conflicts.push(o); },
  });

  assert.equal(outcomes[0].status, "claimed_by_another_tenant");
  assert.equal(conflicts.length, 1);
});

test("a blank endpoint id is skipped rather than written as an empty row", async () => {
  const f = fakeStore();
  const outcomes = await registerChannelEndpoints("tenant_a", [{ channel: "whatsapp", externalId: "   ", label: null }], {
    store: f.store,
  });
  assert.deepEqual(outcomes, []);
  assert.deepEqual(f.writes(), []);
});

test("several endpoints from one credential are each registered", async () => {
  const f = fakeStore();
  const outcomes = await registerChannelEndpoints(
    "tenant_a",
    [
      { channel: "messenger", externalId: "993949857137664", label: "Page" },
      { channel: "instagram", externalId: "17841446988337480", label: "@ig" },
    ],
    { store: f.store },
  );
  assert.deepEqual(outcomes.map((o) => o.status), ["registered", "registered"]);
});

// ── Retirement ──────────────────────────────────────────────────────────────
//
// Registering without retiring leaves a workspace holding an endpoint it no
// longer has credentials for — which keeps routing inbound events there AND
// permanently blocks any other workspace from claiming it, because
// registration correctly refuses to steal a row it does not own.

test("an endpoint the credentials no longer name is retired", async () => {
  const f = fakeStore({
    "whatsapp:OLD_NUMBER": { tenantId: "tenant_a", disabledAt: null, label: null },
  });

  const outcomes = await retireEndpoints("tenant_a", "whatsapp", [WA.externalId], { store: f.store });

  assert.deepEqual(outcomes, [{ channel: "whatsapp", externalId: "OLD_NUMBER", status: "retired" }]);
  assert.notEqual(f.rows.get("whatsapp:OLD_NUMBER")?.disabledAt, null, "the stale row must be disabled");
});

test("retirement disables rather than deletes, so the history of ownership survives", async () => {
  const f = fakeStore({ "whatsapp:OLD": { tenantId: "tenant_a", disabledAt: null, label: null } });
  await retireEndpoints("tenant_a", "whatsapp", [], { store: f.store });
  assert.equal(f.rows.get("whatsapp:OLD")?.tenantId, "tenant_a", "the row is still there, just disabled");
});

test("retirement leaves the endpoint the credentials DO name alone", async () => {
  const f = fakeStore({
    [`whatsapp:${WA.externalId}`]: { tenantId: "tenant_a", disabledAt: null, label: null },
  });
  const outcomes = await retireEndpoints("tenant_a", "whatsapp", [WA.externalId], { store: f.store });
  assert.deepEqual(outcomes, []);
  assert.equal(f.rows.get(`whatsapp:${WA.externalId}`)?.disabledAt, null);
});

test("retirement never touches another tenant's rows", async () => {
  const f = fakeStore({
    "whatsapp:THEIRS": { tenantId: "tenant_b", disabledAt: null, label: null },
  });
  const outcomes = await retireEndpoints("tenant_a", "whatsapp", [], { store: f.store });
  assert.deepEqual(outcomes, []);
  assert.equal(f.rows.get("whatsapp:THEIRS")?.disabledAt, null);
});

test("A RETIRED ENDPOINT CHANGES HANDS — otherwise it is dead to everyone", async () => {
  /*
   * This test previously asserted the opposite, and the reasoning was wrong.
   *
   * I called refusing the transfer "deliberate", on the grounds that moving an
   * endpoint between workspaces should not happen silently. But retirement
   * disables the row, and `resolveChannelTenant` ignores disabled rows — so the
   * refusal left the endpoint owned by a tenant that could not receive on it and
   * claimable by nobody. Permanently dead: strictly worse than the bug this
   * module exists to fix, and reachable through the ordinary "disconnect, then
   * connect somewhere else" path.
   */
  const f = fakeStore({ [`whatsapp:${WA.externalId}`]: { tenantId: "tenant_a", disabledAt: null, label: null } });

  // tenant_a disconnects it...
  await retireEndpoints("tenant_a", "whatsapp", [], { store: f.store });
  // ...and tenant_b, which now holds the number at Meta, connects it.
  const outcomes = await registerChannelEndpoints("tenant_b", [WA], { store: f.store });

  assert.equal(outcomes[0].status, "registered");
  const row = f.rows.get(`whatsapp:${WA.externalId}`);
  assert.equal(row?.tenantId, "tenant_b");
  assert.equal(row?.disabledAt, null, "and it must be live again, or it still routes nothing");
});

test("an ACTIVE endpoint is still never taken, even by a tenant that wants it", async () => {
  // The other half of the same rule. Only retirement releases a claim.
  const f = fakeStore({ [`whatsapp:${WA.externalId}`]: { tenantId: "tenant_a", disabledAt: null, label: null } });
  const outcomes = await registerChannelEndpoints("tenant_b", [WA], { store: f.store });

  assert.equal(outcomes[0].status, "claimed_by_another_tenant");
  assert.equal(f.rows.get(`whatsapp:${WA.externalId}`)?.tenantId, "tenant_a");
});

test("losing the race to the previous owner reconnecting means they keep it", async () => {
  // `claim` re-checks `disabledAt IS NOT NULL` inside the write. The fake store
  // enforces the same guard, so an implementation that dropped it would take a
  // live endpoint here too.
  const f = fakeStore({ [`whatsapp:${WA.externalId}`]: { tenantId: "tenant_a", disabledAt: null, label: null } });
  const outcomes = await registerChannelEndpoints("tenant_b", [WA], { store: f.store });
  assert.equal(outcomes[0].status, "claimed_by_another_tenant");
  assert.equal(f.calls.filter((c) => c.op === "claim").length, 0, "an active row is never even attempted");
});

// ── Cost ────────────────────────────────────────────────────────────────────

test("a healthy endpoint resolves NO label — the cron sweep makes no provider call", async () => {
  const f = fakeStore({
    [`whatsapp:${WA.externalId}`]: { tenantId: "tenant_a", disabledAt: null, label: "Denago EV" },
  });
  let resolved = 0;

  await registerChannelEndpoints(
    "tenant_a",
    [{ ...WA, resolveLabel: async () => { resolved += 1; return "Denago EV"; } }],
    { store: f.store },
  );

  assert.equal(resolved, 0, "a label lookup on every tick can exhaust the cron route's budget");
  assert.deepEqual(f.writes(), []);
});

test("a label IS resolved when a row is actually written", async () => {
  const f = fakeStore();
  let resolved = 0;

  await registerChannelEndpoints(
    "tenant_a",
    [{ ...WA, resolveLabel: async () => { resolved += 1; return "Denago EV · +27 63 336 3533"; } }],
    { store: f.store },
  );

  assert.equal(resolved, 1);
  assert.equal(f.rows.get(`whatsapp:${WA.externalId}`)?.label, "Denago EV · +27 63 336 3533");
});

test("an existing row missing its label gets one filled in", async () => {
  const f = fakeStore({
    [`whatsapp:${WA.externalId}`]: { tenantId: "tenant_a", disabledAt: null, label: null },
  });
  await registerChannelEndpoints("tenant_a", [{ ...WA, resolveLabel: async () => "Denago EV" }], {
    store: f.store,
  });
  assert.equal(f.rows.get(`whatsapp:${WA.externalId}`)?.label, "Denago EV");
});

// ── The cron sweep's budget ─────────────────────────────────────────────────

test("a provider call is bounded by the caller's remaining budget", () => {
  // The sweep checked its deadline only BEFORE starting a tenant, which bounds
  // when a call may begin but not how long it runs — so a discovery started at
  // the edge of a 6s window could still block for the full 10s Graph timeout and
  // overrun the automations route, taking the maintenance behind it with it.
  const source = read("src/lib/channelEndpoints.ts");
  assert.match(source, /function boundedTimeout/);
  assert.match(source, /AbortSignal\.timeout\(boundedTimeout\(/);
  assert.doesNotMatch(
    source,
    /AbortSignal\.timeout\(GRAPH_TIMEOUT_MS\)/,
    "a fixed timeout ignores the budget the caller was given",
  );
});

test("running out of discovery slots does not skip the tenant's WhatsApp registration", () => {
  // It used to `continue` past the whole tenant — skipping the cheap WhatsApp
  // half, which is the entire reason the backstop exists.
  const source = read("src/lib/channelRegistration.ts");
  assert.match(source, /const allowDiscovery = wants && discoveriesLeft > 0;/);
  assert.match(
    source,
    /reconcileTenantChannels\(tenant\.id, \{[\s\S]*?allowDiscovery,/,
    "the tenant is still reconciled; only the provider call is rationed",
  );
});

test("a tenant with no Meta token never consumes a discovery slot", () => {
  // It is missing both Meta rows and always will be, so counting it as a
  // candidate burned a slot every tick and starved tenants that needed one.
  const source = read("src/lib/channelRegistration.ts");
  assert.match(source, /async function wantsMetaDiscovery/);
  assert.match(source, /META_PAGE_ACCESS_TOKEN"\);\s*\r?\n\s*return Boolean\(token/);
});

test("the sweep iterates tenants in a stable order", () => {
  // A truncated sweep should resume predictably rather than depending on
  // whatever order Postgres felt like returning.
  assert.match(read("src/lib/channelRegistration.ts"), /orderBy: \{ id: "asc" \}/);
});

// ── Which keys trigger it ───────────────────────────────────────────────────

test("the credential keys that name an inbound endpoint are recognised", () => {
  assert.equal(keyNamesAnInboundEndpoint("WA_PHONE_NUMBER_ID"), true);
  assert.equal(keyNamesAnInboundEndpoint("META_PAGE_ACCESS_TOKEN"), true);
  assert.equal(keyNamesAnInboundEndpoint("SMTP_PASS"), false);
  assert.equal(keyNamesAnInboundEndpoint("ANTHROPIC_API_KEY"), false);
});

// ── The wiring, which is what actually failed ───────────────────────────────
//
// The logic above was never the problem: there was no caller. These assert the
// call sites exist, because a correct module nothing invokes is exactly the
// state production was in for eighteen days.

test("every path that stores a channel credential reconciles the endpoints", () => {
  for (const file of [
    "src/app/actions/settings.ts",
    "src/app/actions/tenantCredentials.ts",
    "src/app/actions/integrationFlow.ts",
  ]) {
    assert.match(
      read(file),
      /reconcileTenantChannels/,
      `${file} stores channel credentials but never registers the endpoint they name`,
    );
  }
});

test("the cron sweep repairs tenants configured before registration was automatic", () => {
  assert.match(read("src/app/api/cron/automations/route.ts"), /reconcileAllTenantChannels/);
});

test("an unattributable inbound event is LOGGED, never only console.warn'd", () => {
  for (const route of ["src/app/api/webhooks/whatsapp/route.ts", "src/app/api/webhooks/meta/route.ts"]) {
    const source = read(route);
    assert.match(source, /reportUnmappedEndpoint/, `${route} must report a dropped inbound event`);
    assert.doesNotMatch(
      source,
      /console\.warn\(`\[tenant-channel\]/,
      `${route} must not swallow a dropped inbound event into a console line`,
    );
  }
});
