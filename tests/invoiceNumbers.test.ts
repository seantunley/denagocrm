import assert from "node:assert/strict";
import { test } from "node:test";
import Module, { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { formatInvoiceNumber } from "../src/lib/invoiceNumber";

/*
 * Sean, 2026-10-07: "the invoice number must be something different to the quote
 * number — can't be the same with just the prefix changed". Each workspace now
 * has its own invoice sequence, issued once when a quote is accepted.
 */

Module.prototype.require = new Proxy(Module.prototype.require, {
  apply(target, self, args: [string]) {
    return args[0] === "server-only" ? {} : Reflect.apply(target, self, args);
  },
});
const { issueInvoiceNumberInTx, INVOICE_START_MIN, INVOICE_START_MAX, randomInvoiceStart } = createRequire(import.meta.url)("../src/lib/numbering.ts") as typeof import("../src/lib/numbering");

/** A Quote table as the raw SQL sees it: rows per workspace, and the statements it runs. */
function fakeTx(rows: Array<{ id: string; tenantId: string | null; invoiceNumber: number | null }>) {
  const sql = (s: TemplateStringsArray) => s.join("?").replace(/\s+/g, " ");
  const locks: unknown[] = [];
  return {
    locks,
    $executeRaw: async (s: TemplateStringsArray, ...v: unknown[]) => {
      const q = sql(s);
      if (q.includes("pg_advisory_xact_lock")) { locks.push(v[0]); return 1; }
      if (q.includes("UPDATE \"Quote\" SET \"invoiceNumber\"")) {
        const [next, id, tenantId] = v as [number, string, string | null];
        const row = rows.find((r) => r.id === id && r.tenantId === tenantId && r.invoiceNumber === null);
        if (row) row.invoiceNumber = next;
        return row ? 1 : 0;
      }
      throw new Error(`unexpected: ${q}`);
    },
    $queryRaw: async (s: TemplateStringsArray, ...v: unknown[]) => {
      const q = sql(s);
      if (q.includes("MAX(\"invoiceNumber\")")) {
        const max = Math.max(0, ...rows.filter((r) => r.tenantId === v[0]).map((r) => r.invoiceNumber ?? 0));
        return [{ last: max || null }];
      }
      const row = rows.find((r) => r.id === v[0] && r.tenantId === v[1]);
      return row ? [{ invoiceNumber: row.invoiceNumber }] : [];
    },
  };
}

test("printed as INV-047312 — never the quote number", () => {
  assert.equal(formatInvoiceNumber(47312), "INV-047312");
  assert.equal(formatInvoiceNumber(123), "INV-000123");
  assert.equal(formatInvoiceNumber(null), "Not yet issued");
});

test("the random start is always within 10000–99999", () => {
  const draws = Array.from({ length: 2000 }, randomInvoiceStart);
  assert.ok(draws.every((n) => Number.isInteger(n) && n >= 10_000 && n <= 99_999));
  assert.ok(new Set(draws).size > 1500, "actually random");
});

test("each workspace counts on its own, once per quote, never reused", async () => {
  const rows = [
    { id: "a1", tenantId: "tenant_a", invoiceNumber: null },
    { id: "a2", tenantId: "tenant_a", invoiceNumber: null },
    { id: "b1", tenantId: "tenant_b", invoiceNumber: 41 },
    { id: "b2", tenantId: "tenant_b", invoiceNumber: null },
  ];
  const fake = fakeTx(rows);
  const tx = fake as never;
  // A workspace's FIRST invoice starts at a random point, not 1 (Sean): the
  // numbers don't give away how many invoices there have been.
  const first = (await issueInvoiceNumberInTx(tx, "a1", "tenant_a"))!;
  assert.ok(first >= INVOICE_START_MIN && first <= INVOICE_START_MAX, `random start, got ${first}`);
  assert.equal(await issueInvoiceNumberInTx(tx, "a2", "tenant_a"), first + 1, "then counts up by one");
  assert.equal(await issueInvoiceNumberInTx(tx, "b2", "tenant_b"), 42, "workspace B continues its own sequence");
  assert.equal(await issueInvoiceNumberInTx(tx, "a1", "tenant_a"), first, "accepting again keeps the number it was given");
  assert.equal(await issueInvoiceNumberInTx(tx, "a1", "tenant_b"), null, "another workspace's quote is not found");
  assert.deepEqual(rows.map((r) => r.invoiceNumber), [first, first + 1, 41, 42]);
  // Every issue took the workspace's own lock first.
  assert.deepEqual([...new Set(fake.locks)], ["invoice-number:tenant_a", "invoice-number:tenant_b"]);
});

test("issued when a quote is accepted — in the CRM and by signing — under a lock, and unique per workspace", () => {
  const code = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  assert.match(code("src/lib/quoteOutcome.ts"), /if \(updated\.count !== 1\) return \{ kind: "gone" \};\s*\/\/[^\n]*\n\s*await issueInvoiceNumberInTx\(tx, quoteId, tenantId\);/);
  assert.match(code("src/lib/signing/complete.ts"), /sourceSigned = true;\s*\/\/[^\n]*\n\s*await issueInvoiceNumberInTx\(tx, req\.quoteId, req\.tenantId\);/);
  assert.match(code("src/lib/numbering.ts"), /pg_advisory_xact_lock\(hashtext\(\$\{`invoice-number:\$\{tenantId \?\? ""\}`\}\)::bigint\)/);
  assert.match(code("prisma/schema.prisma"), /@@unique\(\[tenantId, invoiceNumber\]\)/);
  const sql = code("prisma/migrations/20261007150000_quote_invoice_numbers/migration.sql");
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "Quote_tenantId_invoiceNumber_key" ON "Quote"\("tenantId", "invoiceNumber"\);/);
  assert.match(sql, /PARTITION BY q\."tenantId"/, "existing invoices numbered per workspace");
  // Each workspace's existing invoices start at its own random point (drawn once, not per row).
  assert.match(sql, /WITH starts AS MATERIALIZED \(/);
  assert.match(sql, /9999 \+ FLOOR\(RANDOM\(\) \* 90000\)::int/);
  assert.match(sql, /WHERE q\."invoiceNumber" IS NULL\s+AND q\."deletedAt" IS NULL\s+AND \(q\."status" = 'accepted' OR q\."invoicedAt" IS NOT NULL\)/);
});
