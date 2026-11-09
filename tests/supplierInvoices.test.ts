import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { invoiceCents, invoiceDay, isSupplierInvoice, nothingRead, parseInvoiceReading } from "../src/lib/supplierInvoiceRules";

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("amounts: grouping and decimal separators, either way round", () => {
  assert.equal(invoiceCents("12 500.00"), 1_250_000);
  assert.equal(invoiceCents("R12,500.50"), 1_250_050);
  assert.equal(invoiceCents("12.500,50"), 1_250_050);
  assert.equal(invoiceCents("12,500"), 1_250_000);
  assert.equal(invoiceCents(12500.5), 1_250_050);
  assert.equal(invoiceCents("12.50"), 1250);
});

test("amounts: nothing, zero, negative-looking or absurd is left blank", () => {
  for (const bad of ["", "abc", "0", "0.00", 0, -5, Number.NaN, 100_000_000, "100000000.00", null, undefined]) {
    assert.equal(invoiceCents(bad), null, String(bad));
  }
});

test("dates: only a real calendar day", () => {
  assert.equal(invoiceDay("2026-11-09")?.toISOString(), "2026-11-09T00:00:00.000Z");
  for (const bad of ["2026-02-30", "09/11/2026", "2026-11-9", "", null, "next Friday"]) assert.equal(invoiceDay(bad), null, String(bad));
});

test("the model's answer is checked field by field — doubtful fields are blank, not guessed", () => {
  const read = parseInvoiceReading('Here you go: {"invoiceNumber":" INV-2041 ","invoiceDate":"2026-11-02","dueDate":"2026-02-31","total":"R 48,300.00","currency":"zar"}');
  assert.equal(read.invoiceNumber, "INV-2041");
  assert.equal(read.invoiceDate?.toISOString().slice(0, 10), "2026-11-02");
  assert.equal(read.dueDate, null);
  assert.equal(read.totalCents, 4_830_000);
  assert.equal(read.currency, "ZAR");
  assert.equal(nothingRead(read), false);

  const junk = parseInvoiceReading("I can't read this document.");
  assert.equal(nothingRead(junk), true);
  assert.equal(nothingRead(parseInvoiceReading('{"invoiceNumber":"---","currency":"rands"}')), true);
});

test("only documents filed as a supplier invoice are read", () => {
  assert.equal(isSupplierInvoice("Supplier invoice"), true);
  assert.equal(isSupplierInvoice("supplier INVOICE"), true);
  assert.equal(isSupplierInvoice("Invoice"), false);
  assert.equal(isSupplierInvoice(null), false);
});

test("the reader never overwrites a confirmed invoice, and logs nothing from the document", () => {
  const reader = src("src/lib/supplierInvoiceReader.ts");
  assert.match(reader, /status === "confirmed"\) return "confirmed-already"/);
  assert.match(reader, /status: \{ not: "confirmed" \}/, "the write itself must skip a row confirmed meanwhile");
  // Every query names the workspace — it runs after the response, outside the request's scope.
  for (const query of reader.match(/basePrisma\.\w+\.\w+\(\{ where: \{[^}]*\}/g) ?? []) assert.match(query, /tenantId/, query);
  for (const call of reader.match(/logError\([^;]*;/g) ?? []) {
    assert.doesNotMatch(call, /await res\.text|json|fields|error\.message/, `log must carry only a status or error name: ${call}`);
  }
});

test("upload reads a supplier invoice after the response, in the document's own workspace", () => {
  const upload = src("src/app/actions/documents.ts");
  assert.match(upload, /isSupplierInvoice\(chosen\.type\)/);
  assert.match(upload, /after\(\(\) => runInTenantScope\(\{ tenantId: owner, system: false \}, \(\) => readSupplierInvoice\(doc\.id, owner\)\)/);
});

test("confirming checks access to the document and audits", () => {
  const actions = src("src/app/actions/supplierInvoices.ts");
  assert.match(actions, /requireDocumentAccess\(documentId, "documents\.upload"\)/);
  assert.match(actions, /logAudit\(\{ action: "supplier_invoice\.confirmed"/);
  assert.match(actions, /status: "confirmed"/);
});

test("the invoice box only appears with the Suppliers module on", () => {
  const panel = src("src/components/DocumentsPanel.tsx");
  assert.match(panel, /const invoiceDocIds = vendors === null\s*\? \[\]/);
});
