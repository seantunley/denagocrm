import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Module from "node:module";
import { createRequire } from "node:module";

import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { runInTenantScope, currentTenantScope } from "../src/lib/tenantScope";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * `tenantWrite.ts` is `server-only` and constructs nothing itself, but it imports
 * `./db`, which builds a PrismaClient at module scope from the ambient
 * DATABASE_URL — which, in a checkout that has a `.env`, is PRODUCTION. Stub both
 * so the REAL ladder can be executed here rather than a local restatement of it:
 * a copy of the rule would pass while the shipped one did something else, which is
 * exactly how this class of defect has survived before.
 */
type Loader = (request: string, parent: NodeJS.Module | undefined, isMain: boolean) => unknown;
const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only" || request === "client-only") return {};
  if (request === "./db" && parent?.filename?.endsWith("tenantWrite.ts")) {
    return { basePrisma: {}, prisma: {} };
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const { inheritedTenantId } = createRequire(import.meta.url)(
  "../src/lib/tenantWrite.ts",
) as typeof import("../src/lib/tenantWrite");

/**
 * THE CHANNEL SCOPE, EXECUTED RATHER THAN PATTERN-MATCHED.
 *
 * `withChannelTenantScope` is `server-only` and reaches Prisma through
 * `resolveChannelTenant`, so the real module cannot be imported into a unit test
 * process. What CAN be executed is the decision itself, and the decision is the
 * whole change: resolve first, bind whenever a tenant resolves, and differ
 * between the two modes ONLY on the unresolved branch.
 *
 * So the rule is restated here as a pure function and the shipped source is
 * checked to match it, in both directions. A test that only asserted the source
 * text would pass on a rule nobody had thought through; a test that only ran a
 * local copy would pass while the shipped code did something else.
 */
async function decideChannelScope<T>(
  enforcing: boolean,
  resolve: () => Promise<string | null>,
  fn: () => Promise<T>,
  onUnresolved: () => T | Promise<T>,
  bind: (tenantId: string, inner: () => Promise<T>) => Promise<T>,
): Promise<T> {
  const tenantId = await resolve();
  if (tenantId) return bind(tenantId, fn);
  return enforcing ? onUnresolved() : fn();
}

type Trace = { bound: string | null; ran: boolean; unresolved: boolean };

async function trace(enforcing: boolean, resolved: string | null): Promise<Trace> {
  const out: Trace = { bound: null, ran: false, unresolved: false };
  await decideChannelScope(
    enforcing,
    async () => resolved,
    async () => {
      out.ran = true;
    },
    async () => {
      out.unresolved = true;
    },
    async (tenantId, inner) => {
      out.bound = tenantId;
      await inner();
    },
  );
  return out;
}

test("a resolved endpoint binds its workspace in BOTH modes", async () => {
  // The defect: this used to short-circuit on `!tenantEnforcing()` BEFORE
  // resolving anything, so the only mode any environment runs in bound nothing
  // and the whole bot runtime fell back to the founding tenant.
  for (const enforcing of [false, true]) {
    const t = await trace(enforcing, "tenant_b");
    assert.equal(t.bound, "tenant_b", `enforcing=${enforcing}: the endpoint's workspace must be bound`);
    assert.equal(t.ran, true, "and the per-event work must still run");
    assert.equal(t.unresolved, false);
  }
});

test("an unmapped endpoint fails closed under enforcement and OPEN while dormant", async () => {
  const enforced = await trace(true, null);
  assert.equal(enforced.ran, false, "enforcing: the work must not run for an endpoint we cannot attribute");
  assert.equal(enforced.unresolved, true);

  // ChannelIdentity is enforcement-prep data no install is required to have
  // backfilled. Failing closed on it while dormant would drop live customer
  // messages on every unmapped install — which is the defect being fixed here,
  // not an acceptable cost of fixing it.
  const dormant = await trace(false, null);
  assert.equal(dormant.ran, true, "dormant: an unmapped endpoint must behave exactly as it does today");
  assert.equal(dormant.unresolved, false);
  assert.equal(dormant.bound, null, "…and unscoped, not bound to some stand-in");
});

test("the shipped source implements that decision, in that order", () => {
  const code = src("src/lib/tenantScopeEntry.ts");
  const fn = code.slice(code.indexOf("export async function withChannelTenantScope"));
  const body = fn.slice(0, fn.indexOf("\n}"));

  // Resolution comes FIRST. The whole defect was an early return in front of it.
  const resolveAt = body.indexOf("await resolveChannelTenant(channel, externalId)");
  const enforcingAt = body.indexOf("tenantEnforcing()");
  assert.ok(resolveAt > -1, "the endpoint must be resolved");
  assert.ok(enforcingAt > resolveAt, "enforcement must not be consulted before the endpoint is resolved");

  assert.match(body, /if \(tenantId\) return runInTenantScope\(\{ tenantId, system: false \}, fn\);/);
  assert.match(body, /return tenantEnforcing\(\) \? onUnresolved\(\) : fn\(\);/);
  // The old shape, named so it cannot come back by accident.
  assert.doesNotMatch(body, /if \(!tenantEnforcing\(\)\) return fn\(\);/);
});

/**
 * THE LADDER THE BOUND SCOPE FEEDS.
 *
 * Binding is only half of it: the consumers have to read the ambient rung while
 * dormant, or a bound scope changes nothing. `botConversationTenantId` is
 * `inheritedTenantId(null)`, which is executed here for the three contexts that
 * matter. (`botTenant.ts` itself is `server-only`; the expression it delegates to
 * is not, and the delegation is asserted in actingScopeRule.test.ts.)
 */
test("the ambient rung answers while enforcement is dormant", async () => {
  __setTenantEnforcingForTests(false);
  try {
    // No scope anywhere — a Server Action today, and today's answer.
    assert.equal(inheritedTenantId(null), DEFAULT_TENANT_ID);

    // Inside a bound channel scope — the webhook, after this change.
    await runInTenantScope({ tenantId: "tenant_b", system: false }, async () => {
      assert.equal(currentTenantScope()?.tenantId, "tenant_b");
      assert.equal(
        inheritedTenantId(null),
        "tenant_b",
        "a webhook inside its endpoint's workspace must resolve that workspace, not the founding one",
      );
    });

    // And it reverts, so nothing leaks into the next event in the same batch.
    assert.equal(inheritedTenantId(null), DEFAULT_TENANT_ID);
  } finally {
    __setTenantEnforcingForTests(null);
  }
});

test("an enforced scope still outranks the ambient one", async () => {
  __setTenantEnforcingForTests(true);
  try {
    await runInTenantScope({ tenantId: "tenant_a", system: false }, async () => {
      assert.equal(inheritedTenantId(null), "tenant_a");
    });
  } finally {
    __setTenantEnforcingForTests(null);
  }
});

/**
 * WHAT THE DEDUPE KEY IS MADE OF.
 *
 * The claim upserts ON CONFLICT ("tenantId","channel","providerId"). With every
 * tenant's events claimed under the founding tenant, that key collapses to
 * (channel, providerId) — and a provider id is not globally unique. This asserts
 * the tenant reaching the statement is the resolved one and not a constant.
 */
test("the inbound claim's tenant is the resolved workspace, not a constant", () => {
  const code = src("src/lib/botInboundEvent.ts");
  const claim = code.slice(
    code.indexOf("export async function claimInboundBotEvent"),
    code.indexOf("export function currentInboundBotClaim"),
  );
  assert.match(claim, /withBotConversationWrite\(async \(tx, tenantId\)/);
  assert.match(claim, /ON CONFLICT \("tenantId", "channel", "providerId"\) DO UPDATE/);
  // The parameter list, in order — $2 is the tenant, and it is the one the
  // wrapper resolved rather than a literal.
  assert.match(claim, /\s+id,\s+tenantId,\s+channel,\s+stableId,/);
  assert.doesNotMatch(claim, /DEFAULT_TENANT_ID/);
});

/**
 * BOTH HALVES, OR NEITHER.
 *
 * #473's refusal in one assertion: the queue's writer and the readers that must
 * see it have to resolve the same expression. If a future change gives either
 * side its own answer, this is where it shows up.
 */
test("the queue writer and every queue reader resolve one expression", () => {
  const code = src("src/lib/botOutbox.ts");

  // The reader used by the idempotency re-read, the claim, the fence and the
  // inbox's delivery states.
  assert.match(code, /function outboxTenantId\(\): string \{\s*return botConversationTenantId\(\);\s*\}/);

  // The writer opens its transaction through the same expression.
  const staff = code.slice(code.indexOf("async function enqueueStaffReplyInWorkspace"));
  assert.match(staff, /withBotConversationWrite\(async \(tx, tenantId\)/);

  // And the whole staff decision is bound ONCE, so the immediate flush that
  // follows it claims what it just wrote.
  const wrapper = code.slice(
    code.indexOf("export async function enqueueStaffReply("),
    code.indexOf("async function enqueueStaffReplyInWorkspace"),
  );
  assert.match(wrapper, /withStaffConversationScope\(\(\) => enqueueStaffReplyInWorkspace\(input\)\)/);
  assert.match(
    code,
    /export async function flushBotOutboxConversation\([\s\S]*?withStaffConversationScope\(\(\) => drainConversation\(/,
    "the immediate flush must resolve the same workspace as the reply it drains",
  );
});
