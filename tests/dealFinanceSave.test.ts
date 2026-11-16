import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import Module, { createRequire } from "node:module";

/*
 * Saving a deal's finance only over the version the form SHOWED (review of #1137): a stale form — same status, an old
 * reference or note — is refused, never laid over a colleague's newer edit. Run against a fake DealFinance table that
 * behaves like Postgres on the calls the action makes (updatedAt moves on every update; updateMany reports its count).
 */

type Row = { id: string; tenantId: string; leadId: string; quoteId: string; vendorId: string; status: string; statusAt: Date; updatedAt: Date; reference: string | null; note: string | null; vendor: { name: string } };
let rows: Row[] = [];
let clock = Date.UTC(2026, 10, 16, 9);
const tick = () => new Date((clock += 1000));
const T = "tenant_a", LEAD = "lead_1", HOUSE = "vendor_wesbank";
// One deal, three quotes: Q-1044 and Q-1045 both in play (only one will be accepted), Q-1043 cancelled.
const Q44 = "quote_1044", Q45 = "quote_1045", Q43 = "quote_1043";
const QUOTES = [
  { id: Q44, number: 1044, leadId: LEAD, status: "draft", supersededAt: null, deletedAt: null },
  { id: Q45, number: 1045, leadId: LEAD, status: "draft", supersededAt: null, deletedAt: null },
  { id: Q43, number: 1043, leadId: LEAD, status: "cancelled", supersededAt: null, deletedAt: null },
];
const QUOTE = Q45;
const matches = (row: Row, where: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) => (v instanceof Date ? (row as never as Record<string, Date>)[k]?.getTime() === v.getTime() : (row as never as Record<string, unknown>)[k] === v));

const db: Record<string, unknown> = {
  // The action's transaction runs against the same fake table; the row lock is a no-op here.
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  $queryRaw: async () => [{ "?column?": 1 }],
  lead: { findFirst: async () => ({ id: LEAD, contactId: null }) },
  quote: { findFirst: async ({ where }: { where: { id: string } }) => QUOTES.find((q) => q.id === where.id) ?? null },
  // WesBank is on this deal's suppliers; any other id is not.
  dealVendor: { findFirst: async ({ where }: { where: { vendorId: string } }) => (where.vendorId === HOUSE ? { vendor: { id: HOUSE, name: "WesBank" } } : null) },
  dealFinance: {
    findFirst: async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => matches(r, where)) ?? null,
    create: async ({ data }: { data: Omit<Row, "id" | "statusAt" | "updatedAt" | "vendor"> }) => {
      const at = tick();
      const row = { ...data, id: `fin_${rows.length + 1}`, statusAt: at, updatedAt: at, vendor: { name: "WesBank" } } as Row;
      rows.push(row);
      return { id: row.id };
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
      const found = rows.filter((r) => matches(r, where));
      for (const r of found) Object.assign(r, data, { updatedAt: tick() });
      return { count: found.length };
    },
  },
};

type Loader = (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const loader = Module as unknown as { _load: Loader };
const realLoad = loader._load;
loader._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only") return {};
  if (request === "next/cache") return { revalidatePath: () => {} };
  if (request === "@/lib/db") return { prisma: db };
  if (request === "@/lib/actingTenant") return { actingTenantId: async () => T };
  if (request === "@/lib/audit") return { logAudit: async () => {} };
  if (request === "@/lib/permissions") return { requireLeadAccess: async () => ({ id: "user_1" }), requireQuoteAccess: async () => ({ id: "user_1" }) };
  if (request === "@/lib/modules/enabled") return { isModuleEnabled: async () => true };
  return realLoad.call(this, request, parent, isMain);
} as Loader;
const { saveDealFinance } = createRequire(import.meta.url)("../src/app/actions/dealFinance.ts") as typeof import("../src/app/actions/dealFinance");

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries({ vendorId: HOUSE, status: "submitted", reference: "", note: "", ...fields })) data.set(k, v);
  return data;
};
beforeEach(() => { rows = []; });

test("a stale form can't overwrite a newer reference or note — same status or not", async () => {
  assert.deepEqual(await saveDealFinance(QUOTE, form({ reference: "APP-1", version: "" })), { success: "Finance: Submitted" });
  const opened = rows[0].updatedAt.toISOString(); // two people open the deal now
  // A changes only the reference (same status: statusAt doesn't move).
  assert.ok((await saveDealFinance(QUOTE, form({ reference: "APP-2", version: opened }))).success);
  assert.equal(rows[0].reference, "APP-2");
  // B saves the form they opened before — old reference, a new note. Refused; A's reference stands.
  const stale = await saveDealFinance(QUOTE, form({ reference: "APP-1", note: "called them", version: opened }));
  assert.match(String(stale.error), /Someone else changed the finance since you opened it/);
  assert.equal(rows[0].reference, "APP-2");
  assert.equal(rows[0].note, null);
  // Refreshed, B's note lands over A's version.
  assert.ok((await saveDealFinance(QUOTE, form({ reference: "APP-2", note: "called them", version: rows[0].updatedAt.toISOString() }))).success);
  assert.equal(rows[0].note, "called them");
});

test("FINANCE IS PER QUOTE (Sean: changing Q-1045's changed Q-1044's): each of the deal's quotes keeps its own", async () => {
  assert.ok((await saveDealFinance(Q44, form({ status: "submitted", reference: "APP-44", version: "" }))).success);
  assert.ok((await saveDealFinance(Q45, form({ status: "docs_outstanding", reference: "APP-45", version: "" }))).success, "Q-1045 starts its own");
  assert.equal(rows.length, 2);
  const q45 = rows.find((r) => r.quoteId === Q45)!;
  assert.ok((await saveDealFinance(Q45, form({ status: "declined", reference: "APP-45", version: q45.updatedAt.toISOString() }))).success);
  assert.equal(rows.find((r) => r.quoteId === Q45)!.status, "declined");
  const q44 = rows.find((r) => r.quoteId === Q44)!;
  assert.equal(q44.status, "submitted", "Q-1044's finance is untouched");
  assert.equal(q44.reference, "APP-44");
});

test("no new finance on a cancelled quote — finance goes on the quote that's going ahead", async () => {
  assert.match(String((await saveDealFinance(Q43, form({ version: "" }))).error), /Q-1043 is cancelled — start the finance on the quote that's going ahead/);
  assert.equal(rows.length, 0);
});

test("a finance house that isn't on the deal is refused — a cash deal can't be financed by a stray post", async () => {
  assert.match(String((await saveDealFinance(QUOTE, form({ vendorId: "vendor_other", version: "" }))).error), /Add the finance house to this deal's suppliers first/);
  assert.equal(rows.length, 0);
});

test("a form with no version can't overwrite a finance it never showed; the chaser's clock moves only with the status", async () => {
  await saveDealFinance(QUOTE, form({ version: "" }));
  const statusAt = rows[0].statusAt.getTime();
  // Opened when the deal wasn't financed, saved after a colleague started it.
  assert.match(String((await saveDealFinance(QUOTE, form({ status: "approved", version: "" }))).error), /Someone else changed the finance/);
  assert.equal(rows[0].status, "submitted");
  await saveDealFinance(QUOTE, form({ note: "chased", version: rows[0].updatedAt.toISOString() }));
  assert.equal(rows[0].statusAt.getTime(), statusAt, "a note is not a status change");
  await saveDealFinance(QUOTE, form({ status: "approved", note: "chased", version: rows[0].updatedAt.toISOString() }));
  assert.ok(rows[0].statusAt.getTime() > statusAt);
});
