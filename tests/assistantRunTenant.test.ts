import assert from "node:assert/strict";
import { test } from "node:test";
import Module, { createRequire } from "node:module";
import { Prisma } from "@prisma/client";

/*
 * #788 review: a run key is one person's in ONE workspace. The REAL run module,
 * against a table that behaves as the database does with tenant enforcement
 * OFF — no ambient filter, so the module's own predicates are the only
 * boundary — and the same person belonging to workspaces A and B.
 */

type Row = { id: string; tenantId: string; userId: string; clientKey: string; status: string; statusText: string | null; partial: string | null; result: unknown; updatedAt: Date };
const rows: Row[] = [];
const matches = (row: Row, where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => row[k as keyof Row] === v);
// A compound-unique lookup ({ a_b_c: { a, b, c } }) is a match on its fields.
const flat = (where: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(where).flatMap(([k, v]) => (v && typeof v === "object" && !(v instanceof Date) ? Object.entries(v) : [[k, v]])));

const prisma = {
  assistantRun: {
    create: async ({ data }: { data: { tenantId: string; userId: string; clientKey: string } }) => {
      // The table's unique index, as the schema declares it.
      if (rows.some((r) => r.tenantId === data.tenantId && r.userId === data.userId && r.clientKey === data.clientKey)) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
      }
      const row: Row = { id: `run_${rows.length + 1}`, status: "accepted", statusText: null, partial: null, result: null, updatedAt: new Date(), ...data };
      rows.push(row);
      return { id: row.id };
    },
    findUnique: async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => matches(r, flat(where))) ?? null,
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data, { updatedAt: new Date() }));
      return { count: hit.length };
    },
  },
};

type Loader = (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const loader = Module as unknown as { _load: Loader };
const realLoad = loader._load;
loader._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only") return {};
  const file = (parent?.filename ?? "").replace(/\\/g, "/");
  if (file.endsWith("src/lib/assistantRun.ts")) {
    if (request === "./db") return { prisma };
    if (request === "./errorLog") return { logError: async () => {} };
    if (request === "./tenantWrite") return { inheritedTenantId: () => "tenant_a" };
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const { claimRun, readRun, runRecorder } = createRequire(import.meta.url)("../src/lib/assistantRun.ts") as typeof import("../src/lib/assistantRun");

const KEY = "k_known_run_key_123";
const done = { ok: true as const, answer: "Workspace A's answer", rows: [], tools: [], learned: 0, actions: [], choices: [], saved: true };

test("a run key from workspace A, replayed by the same person from B, reaches nothing of A's", async () => {
  const a = await claimRun("tenant_a", "user_1", KEY);
  assert.equal(a.created, true);
  await runRecorder(a.id, "tenant_a", "user_1").finish(done, { total: 1 });

  // From B: the reconnect read finds nothing…
  assert.equal(await readRun("tenant_b", "user_1", KEY), null);
  // …a POST with the same key is a NEW run in B, not a follow of A's…
  const b = await claimRun("tenant_b", "user_1", KEY);
  assert.equal(b.created, true, "the same key exists independently in both workspaces");
  assert.notEqual(b.id, a.id);
  // …and a recorder bound to B can't write A's row, even given its id.
  await runRecorder(a.id, "tenant_b", "user_1").finish({ ok: false, error: "overwritten" }, {});

  const still = await readRun("tenant_a", "user_1", KEY);
  assert.equal(still?.status, "completed");
  assert.deepEqual(still?.result, done);
  // A retry in A still follows A's own run — exactly once there.
  assert.deepEqual(await claimRun("tenant_a", "user_1", KEY), { id: a.id, created: false });
});
