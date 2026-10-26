import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import Module, { createRequire } from "node:module";

/*
 * ONE CONFIRM, ONE JOB CARD (review of #911). A DAX job card confirmed in the chat whose answer was lost, then
 * confirmed again, must not open a second job card. The REAL openJobCard runs here; only what needs a request or a
 * database is stood in for — a tiny in-memory store that behaves like the two tables involved, including a primary
 * key that refuses a second row (Prisma's P2002) and a transaction that is undone when it throws.
 */
type Row = Record<string, unknown> & { id: string };
const db = { jobCards: [] as Row[], keys: [] as Row[], seq: 0, audits: 0, raceKey: null as string | null };

const tableOf = (rows: () => Row[]) => ({
  findFirst: async ({ where }: { where: Row }) => rows().find((row) => Object.entries(where).every(([k, v]) => row[k] === v)) ?? null,
  create: async ({ data }: { data: Row }) => {
    const row = { ...data, id: data.id ?? `cmjobcard${String(++db.seq).padStart(16, "0")}` };
    if (rows().some((other) => other.id === row.id)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    rows().push(row);
    return row;
  },
  aggregate: async () => ({ _max: { number: rows().reduce<number | null>((max, row) => Math.max(max ?? 0, row.number as number), null) } }),
});
const basePrisma = {
  jobCard: tableOf(() => db.jobCards),
  assistantPendingAction: tableOf(() => db.keys),
  mileageLog: { create: async () => ({}) },
  $executeRaw: async () => 0,
  // All or nothing, like Postgres: a throw undoes every row the transaction wrote.
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    const before = { jobCards: [...db.jobCards], keys: [...db.keys] };
    try {
      // A second Confirm that got past the first look at the same moment: its key is already taken when it writes.
      if (db.raceKey) db.keys.push({ id: db.raceKey, tenantId: "t1", card: { kind: "confirm_key", jobCardId: "cmearlierjobcard00000000", number: 1001 } });
      return await fn(basePrisma);
    } catch (error) {
      db.jobCards = before.jobCards;
      db.keys = before.keys.concat(db.raceKey ? db.keys.filter((row) => row.id === db.raceKey) : []);
      throw error;
    } finally {
      db.raceKey = null;
    }
  },
};

type Loader = (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const loader = Module as unknown as { _load: Loader };
const realLoad = loader._load;
loader._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only") return {};
  if ((parent?.filename ?? "").replace(/\\/g, "/").endsWith("src/app/actions/jobcards.ts")) {
    switch (request) {
      case "@/lib/db": return { prisma: { vehicle: { findUniqueOrThrow: async () => ({ id: "v1", model: "Nomad", contactId: "c1" }) } }, basePrisma };
      case "@/lib/modules/enabled": return { isModuleEnabled: async () => true };
      case "@/lib/actingScope": return { withActingStaffScope: (fn: () => unknown) => fn() };
      case "@/lib/actingTenant": return { actingTenantId: async () => "t1" };
      case "@/lib/permissions": return { requireVehicleAccess: async () => ({ id: "u1" }), requireJobCardAccess: async () => ({ id: "u1" }) };
      case "@/lib/audit": return { logAudit: async () => { db.audits++; } };
      case "next/cache": return { revalidatePath: () => {} };
      case "next/navigation": return { redirect: () => { throw new Error("NEXT_REDIRECT"); } };
    }
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const { openJobCard } = createRequire(import.meta.url)("../src/app/actions/jobcards.ts") as typeof import("../src/app/actions/jobcards");
const KEY = `qk_${"a".repeat(32)}`;
const input = { vehicleId: "v1", description: "Service — brakes squeaking", priority: "high", confirmKey: KEY };

beforeEach(() => {
  db.jobCards = [];
  db.keys = [];
  db.audits = 0;
  db.raceKey = null;
});

test("Confirm pressed again with the same key gets the SAME job card back — no second one, no second audit", async () => {
  const first = await openJobCard(input);
  assert.ok(!("repeated" in first));
  const again = await openJobCard(input);
  assert.deepEqual(again, { id: first.id, number: first.number, repeated: true });
  assert.equal(db.jobCards.length, 1, "one job card");
  assert.equal(db.audits, 1, "one jobcard.opened entry");
  // The key is spent in this workspace, with the job card it opened.
  assert.deepEqual(db.keys.map((row) => [row.id, row.tenantId, (row.card as Row).jobCardId]), [[KEY, "t1", first.id]]);
});

test("two Confirms at the same moment: the second's whole transaction is undone, and it gets the first's job card", async () => {
  db.raceKey = KEY;
  const second = await openJobCard(input);
  assert.deepEqual(second, { id: "cmearlierjobcard00000000", number: 1001, repeated: true });
  assert.equal(db.jobCards.length, 0, "the job card it began is not left behind");
  assert.equal(db.audits, 0);
});

test("a different card (another key) opens another job card; the form (no key) is unchanged", async () => {
  await openJobCard(input);
  await openJobCard({ ...input, confirmKey: `qk_${"b".repeat(32)}` });
  await openJobCard({ vehicleId: "v1", description: "From the form" });
  assert.equal(db.jobCards.length, 3);
  assert.equal(db.keys.length, 2, "the form spends no key");
  await assert.rejects(openJobCard({ ...input, confirmKey: "not-a-key" }), /confirmation isn't valid/);
});
