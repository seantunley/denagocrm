import assert from "node:assert/strict";
import { test } from "node:test";
import Module, { createRequire } from "node:module";

/**
 * The Trash boundary, RUN rather than read.
 *
 * #494 shipped `actingTrashPredicate` with source-text assertions only, and said
 * so: none of `softDeleteRecord`, `restoreRecord` or the Trash page was actually
 * executed by a test. A grep proves the predicate is spelled somewhere in the
 * file; it cannot prove what the function returns when the session cannot be
 * resolved, which is the case that was wrong.
 *
 * The defect these cover: `actingScopeClass()` answers `global` whenever a
 * session exists but cannot be resolved to ONE workspace — a claim minted before
 * `tid` existed, a claim gone stale, or a claim that is AMBIGUOUS because the
 * user holds two or more active memberships (`honoredTenantClaim` drops that to
 * null rather than guess). `global` used to return `{}`: no predicate at all, on
 * the RLS-bypassing client. So an owner in that state read every workspace's
 * trash and could restore another tenant's records by id.
 */

type Loader = (
  this: unknown,
  request: string,
  parent: { filename?: string } | undefined,
  isMain: boolean,
) => unknown;

/** What `actingScopeClass()` will answer for the next call. */
let scope: { mode: "tenant"; tenantId: string } | { mode: "global" } | { mode: "closed" } = {
  mode: "tenant",
  tenantId: "tenant-a",
};

type Call = { model: string; op: string; where: Record<string, unknown> };
const calls: Call[] = [];

/**
 * Deliberately permissive, exactly like prismaRecordAccessSpy: it records the
 * `where` and reports a row as matched REGARDLESS of tenant. So the only thing
 * that can stop a cross-tenant write here is the predicate itself — if the
 * helper omits it, this fake happily "updates" the other tenant's row and the
 * test fails. A fake that enforced tenancy would pass vacuously.
 */
const fakeDelegate = {
  updateMany: (args: { where: Record<string, unknown> }) => {
    calls.push({ model: "contact", op: "updateMany", where: args.where });
    return Promise.resolve({ count: 1 });
  },
  findFirst: (args: { where: Record<string, unknown> }) => {
    calls.push({ model: "contact", op: "findFirst", where: args.where });
    return Promise.resolve({ id: String(args.where.id), tenantId: "tenant-b" });
  },
};

const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only" || request === "client-only") return {};
  const from = (parent?.filename ?? "").replace(/\\/g, "/");
  if (from.endsWith("src/lib/trash.ts")) {
    if (request === "./db") return { basePrisma: { contact: fakeDelegate } };
    if (request === "./actingScope") return { actingScopeClass: () => Promise.resolve(scope) };
    if (request === "./storage") return { deleteFile: () => Promise.resolve() };
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const require_ = createRequire(import.meta.url);
const trash = require_("../src/lib/trash.ts") as typeof import("../src/lib/trash");
const { TenantScopeError } = require_("../src/lib/tenantGuard.ts") as typeof import("../src/lib/tenantGuard");

const reset = () => {
  calls.length = 0;
};

test("a resolved workspace scopes the delete, and the predicate is on the write itself", async () => {
  reset();
  scope = { mode: "tenant", tenantId: "tenant-a" };
  await trash.softDeleteRecord("contact", "rec-1", "reason", "Rep");
  const write = calls.find((c) => c.op === "updateMany");
  assert.ok(write, "the delete must go through updateMany, so a foreign id matches no rows");
  assert.equal(write.where.tenantId, "tenant-a", "the write must carry the acting tenant");
  assert.equal(write.where.id, "rec-1");
});

test("an AMBIGUOUS session cannot delete — it refuses instead of running unfiltered", async () => {
  // THE DEFECT. Two active memberships => honoredTenantClaim returns null =>
  // actingScopeClass answers `global`. This used to produce `{}` and a delete
  // with no tenant predicate at all.
  reset();
  scope = { mode: "global" };
  await assert.rejects(
    () => trash.softDeleteRecord("contact", "rec-1", "reason", "Rep"),
    TenantScopeError,
    "an unresolvable session must refuse, not delete unscoped",
  );
  assert.equal(calls.length, 0, "nothing may reach the database at all");
});

test("an AMBIGUOUS session cannot restore another tenant's record", async () => {
  // The same hole with the sign flipped: restoring resurrects data the owning
  // tenant deliberately deleted.
  reset();
  scope = { mode: "global" };
  await assert.rejects(() => trash.restoreRecord("contact", "rec-1"), TenantScopeError);
  assert.equal(calls.length, 0, "nothing may reach the database at all");
});

test("an enforced request with no scope still refuses", async () => {
  reset();
  scope = { mode: "closed" };
  await assert.rejects(() => trash.softDeleteRecord("contact", "rec-1", "reason", "Rep"), TenantScopeError);
  await assert.rejects(() => trash.restoreRecord("contact", "rec-1"), TenantScopeError);
  assert.equal(calls.length, 0);
});

test("the restore path carries the tenant on both the write and the re-read", async () => {
  reset();
  scope = { mode: "tenant", tenantId: "tenant-a" };
  await trash.restoreRecord("contact", "rec-1");
  const scoped = calls.filter((c) => c.where.tenantId === "tenant-a");
  assert.equal(
    scoped.length,
    calls.length,
    `every statement must be scoped; unscoped: ${JSON.stringify(calls.filter((c) => c.where.tenantId !== "tenant-a"))}`,
  );
  assert.ok(calls.some((c) => c.op === "updateMany"), "the restore itself must be conditional");
});

test("actingTrashPredicate has exactly two outcomes: a real tenant, or a throw", async () => {
  // Stated as a rule so a future `return {}` for some third case fails here.
  scope = { mode: "tenant", tenantId: "tenant-x" };
  assert.deepEqual(await trash.actingTrashPredicate("t"), { tenantId: "tenant-x" });
  for (const bad of [{ mode: "global" as const }, { mode: "closed" as const }]) {
    scope = bad;
    await assert.rejects(
      () => trash.actingTrashPredicate("t"),
      TenantScopeError,
      `${bad.mode} must refuse — it must never resolve to "no predicate"`,
    );
  }
});
