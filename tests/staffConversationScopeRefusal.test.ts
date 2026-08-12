import assert from "node:assert/strict";
import { test } from "node:test";
import Module, { createRequire } from "node:module";

/**
 * `withStaffConversationScope` must REFUSE an unresolvable staff session, not
 * bind the founding tenant.
 *
 * It used to end `.catch(() => DEFAULT_TENANT_ID)`. That swallowed exactly the
 * refusal `actingTenantId()` was changed to make, on a path that is explicitly
 * user-originated: `pauseBotConversation` and `resumeBotConversation` are Server
 * Actions a signed-in person triggers, and `enqueueStaffReply` binds through
 * here before writing the pause, the outbox row and the reply decision. In the
 * outbox path the bound tenant chooses the BotSession/outbox partition and the
 * ambient provider context — so a stale or ambiguous session had its work
 * executed under the founding tenant.
 *
 * The previous tests covered the two passing shapes (an already-bound scope is
 * preserved; a bound scope is `system: false`) and never drove a failure, which
 * is why the catch survived. These execute the refusal.
 */

type Loader = (
  this: unknown,
  request: string,
  parent: { filename?: string } | undefined,
  isMain: boolean,
) => unknown;

/** What the stubbed resolver does on the next call. */
let resolver: () => Promise<string> = () => Promise.resolve("tenant-b");

const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only" || request === "client-only") return {};
  const from = (parent?.filename ?? "").replace(/\\/g, "/");
  if (from.endsWith("src/lib/actingScope.ts")) {
    // Only the SESSION resolver is swapped. runInTenantScope, currentTenantScope
    // and the function under test are the shipped ones — a local restatement of
    // the rule would pass while the real one did something else, which is how
    // this class of defect has survived before.
    if (request === "./actingTenant") return { actingTenantId: () => resolver() };
    if (request === "./db") return { basePrisma: {} };
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const require_ = createRequire(import.meta.url);
const { withStaffConversationScope } = require_(
  "../src/lib/actingScope.ts",
) as typeof import("../src/lib/actingScope");
const { runInTenantScope, currentTenantScope } = require_(
  "../src/lib/tenantScope.ts",
) as typeof import("../src/lib/tenantScope");
const { TenantScopeError } = require_("../src/lib/tenantGuard.ts") as typeof import("../src/lib/tenantGuard");

test("no ambient scope + an unresolvable session REFUSES, and the callback never runs", async () => {
  // THE BLOCKER. Before the fix this bound DEFAULT_TENANT_ID and ran `fn`, so a
  // stale or ambiguous staff session had its bot pause / outbox write executed
  // under the founding tenant.
  resolver = () => Promise.reject(new TenantScopeError("no workspace"));
  let ran = false;
  await assert.rejects(
    () => withStaffConversationScope(async () => { ran = true; }),
    TenantScopeError,
    "an unresolvable staff session must refuse rather than fall back to a workspace",
  );
  assert.equal(ran, false, "the callback must not run at all — nothing may be written under a guessed owner");
});

test("the refusal is not swallowed into some other workspace either", async () => {
  // Guards the shape as well as the outcome: any `catch` that substituted a
  // tenant would let the callback run and observe a bound scope.
  resolver = () => Promise.reject(new TenantScopeError("no workspace"));
  let observed: string | null | undefined = "not-run";
  await withStaffConversationScope(async () => {
    observed = currentTenantScope()?.tenantId ?? null;
  }).catch(() => {});
  assert.equal(observed, "not-run", "no scope may be bound when the session cannot be resolved");
});

test("an already-bound ambient workspace is preserved, and the resolver is not consulted", async () => {
  // The legitimate background path: a webhook, cron slice or channel drain
  // arrives properly scoped and returns early. This is what the removed catch
  // was really defending, and it is defended by the line above it instead.
  resolver = () => Promise.reject(new Error("the resolver must not be called when a scope is already bound"));
  const seen = await runInTenantScope({ tenantId: "tenant-b", system: false }, () =>
    withStaffConversationScope(async () => currentTenantScope()?.tenantId ?? null),
  );
  assert.equal(seen, "tenant-b", "an already-bound workspace must be left exactly as it is");
});

test("a resolvable staff session with no ambient scope binds THAT workspace", async () => {
  // The ordinary signed-in case still works, and binds the session's own
  // workspace rather than anything inherited or defaulted.
  resolver = () => Promise.resolve("tenant-b");
  const seen = await withStaffConversationScope(async () => currentTenantScope()?.tenantId ?? null);
  assert.equal(seen, "tenant-b");
});

test("the bound scope is a tenant scope, never a system one", async () => {
  // `system: true` bypasses the db guard entirely, so binding one here would
  // hand the whole callback cross-tenant reach.
  resolver = () => Promise.resolve("tenant-b");
  const seen = await withStaffConversationScope(async () => currentTenantScope());
  assert.equal(seen?.system, false, "a staff conversation must never run in a system scope");
});
