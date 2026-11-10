import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dealFileChecklist, DEFAULT_DEAL_FILE_CONFIG as CFG } from "../src/lib/dealFile";
import { DEFAULT_DOCUMENT_TYPES } from "../src/lib/documentLabels";

const quote = (over: Partial<Parameters<typeof dealFileChecklist>[0][number]> = {}) => ({
  number: 1029, status: "sent", invoicedAt: null, deliverySignatureRef: null, ...over,
});
const doc = (tag: string | null, vendorId: string | null = null, vendorName: string | null = null) => ({ tag, vendorId, vendorName });
const missing = (items: ReturnType<typeof dealFileChecklist>) => items.filter((item) => !item.done).map((item) => item.label);

test("a fresh deal is missing everything but the sent quote", () => {
  const items = dealFileChecklist([quote()], [], DEFAULT_DOCUMENT_TYPES, CFG);
  assert.deepEqual(missing(items), [
    "Invoice", "Customer proof of payment", "Delivery paperwork",
    "Supplier quote", "Supplier invoice", "Proof of payment — supplier",
  ]);
});

test("a draft quote is not the quote on file", () => {
  assert.equal(dealFileChecklist([quote({ status: "draft" })], [], DEFAULT_DOCUMENT_TYPES, CFG)[0].done, false);
});

test("deliveries-board paperwork ticks the customer boxes", () => {
  const items = dealFileChecklist(
    [quote({ status: "accepted", invoicedAt: new Date() })],
    [doc("pop"), doc("delivery-note")],
    DEFAULT_DOCUMENT_TYPES,
    CFG,
  );
  assert.deepEqual(missing(items).filter((label) => !label.startsWith("Supplier") && !label.startsWith("Proof of payment — supplier")), []);
});

test("the signed delivery note counts as the delivery paper", () => {
  const items = dealFileChecklist([quote({ deliverySignatureRef: "x.png" })], [], DEFAULT_DOCUMENT_TYPES, CFG);
  assert.equal(items.find((item) => item.key === "delivery")?.done, true);
});

test("each supplier needs its own quote, invoice and proof of payment", () => {
  const items = dealFileChecklist(
    [quote()],
    [
      doc("Supplier quote", "oem", "Denago"), doc("Supplier invoice", "oem", "Denago"), doc("Proof of payment — supplier", "oem", "Denago"),
      doc("Supplier quote", "wrap", "Wrap Co"),
    ],
    DEFAULT_DOCUMENT_TYPES,
    CFG,
  );
  const supplierMissing = missing(items).filter((label) => label.includes("—") && !label.startsWith("Customer"));
  assert.deepEqual(supplierMissing, ["Supplier invoice — Wrap Co", "Proof of payment — supplier — Wrap Co"]);
});

test("a declared supplier is asked for before any of its papers arrive (review of #1040)", () => {
  const items = dealFileChecklist([quote()], [doc("Supplier quote", "oem", "Denago")], DEFAULT_DOCUMENT_TYPES, CFG, [
    { id: "oem", name: "Denago" },
    { id: "wrap", name: "Wrap Studio" },
  ]);
  const wrap = items.filter((item) => item.label.endsWith("— Wrap Studio"));
  assert.deepEqual(wrap.map((item) => [item.label, item.done]), [
    ["Supplier quote — Wrap Studio", false],
    ["Supplier invoice — Wrap Studio", false],
    ["Proof of payment — supplier — Wrap Studio", false],
  ]);
  assert.equal(items.filter((item) => item.label.endsWith("— Denago")).length, 3, "declared and on a document: listed once");
});

test("a supplier's name compares without case, punctuation or the company form", async () => {
  const { normaliseVendorName, vendorKind } = await import("../src/lib/vendors");
  assert.equal(normaliseVendorName("Wrap Studio (Pty) Ltd"), normaliseVendorName("wrap studio"));
  assert.equal(normaliseVendorName("A&B Transport CC"), normaliseVendorName("A and B transport"));
  assert.notEqual(normaliseVendorName("Wrap Co"), normaliseVendorName("Wrap"));
  assert.equal(vendorKind("transport"), "transport");
  assert.equal(vendorKind("bank"), "other");
});

test("a supplier file filed before suppliers existed still counts", () => {
  const items = dealFileChecklist([quote()], [doc("supplier quote")], DEFAULT_DOCUMENT_TYPES, CFG);
  assert.equal(items.find((item) => item.label === "Supplier quote")?.done, true);
});

test("a checklist type the workspace removed says how to fix it", () => {
  const items = dealFileChecklist([quote()], [], ["ID document"], CFG);
  assert.match(items.find((item) => item.label === "Supplier invoice")?.detail ?? "", /Settings → Document types/);
});

test("a quote's papers are grouped: the customer's, then each supplier's by name, then unnamed supplier papers", async () => {
  const { partiesOf } = await import("../src/lib/dealFile");
  const jet = { id: "v1", name: "Jetman Distributors" };
  const acme = { id: "v2", name: "Acme Wraps" };
  const docs = [
    { id: "1", tag: "invoice", vendor: null },
    { id: "2", tag: "Proof of payment — supplier", vendor: jet },
    { id: "3", tag: "Proof of payment — customer", vendor: null },
    { id: "4", tag: "Supplier quote", vendor: acme },
    { id: "5", tag: "Supplier invoice", vendor: jet },
    { id: "6", tag: "Supplier invoice", vendor: null },
  ];
  const sections = partiesOf(docs);
  assert.deepEqual(sections.map((s) => [s.label, s.docs.map((d) => d.id)]), [
    ["Customer", ["1", "3"]],
    ["Supplier · Acme Wraps", ["4"]],
    ["Supplier · Jetman Distributors", ["2", "5"]],
    ["Suppliers", ["6"]],
  ]);
  // Only customer papers: one section, which the panel shows with no headings.
  assert.deepEqual(partiesOf([{ tag: "invoice", vendor: null }]).map((s) => s.supplier), [false]);
});

test("the deal page shows the deal file for every quote on the lead, and only the current versions", () => {
  const page = readFileSync(new URL("../src/app/(app)/deals/[id]/page.tsx", import.meta.url), "utf8");
  // The page reads its file through the shared loader (also the ZIP download's).
  const data = readFileSync(new URL("../src/lib/dealFileData.ts", import.meta.url), "utf8");
  assert.match(page, /await loadDealFile\(quote, user\)/);
  assert.match(data, /dealFileChecklist\(/);
  assert.match(data, /getAccessibleQuoteIds\(user\)/);
  assert.match(data, /replacedById: null/);
});

test("the deal file lists every signature request — no silent cap (review of #1040)", () => {
  const page = readFileSync(new URL("../src/app/(app)/deals/[id]/page.tsx", import.meta.url), "utf8");
  const data = readFileSync(new URL("../src/lib/dealFileData.ts", import.meta.url), "utf8");
  assert.match(data, /dealSignatureRequests\(dealQuoteIds\)/);
  assert.doesNotMatch(page, /signatureRequest\.findMany/);
  assert.doesNotMatch(data, /\btake:/);
});

test("a new purchase order and its lines and units carry the workspace the supplier was checked in (review of #1040)", () => {
  const stock = readFileSync(new URL("../src/app/actions/stock.ts", import.meta.url), "utf8");
  const action = stock.slice(stock.indexOf("export async function createPurchaseOrder("), stock.indexOf("export async function receivePurchaseOrder("));
  assert.match(action, /const tenantId = await actingTenantId\(\);/);
  assert.match(action, /vendor = await prisma\.vendor\.findFirst\(\{\s*where: \{ id: str\(formData\.get\("vendorId"\)\), tenantId, deletedAt: null \}/);
  assert.ok(action.indexOf("const tenantId = await actingTenantId();") < action.indexOf("prisma.vendor.findFirst("));
  assert.match(action, /tx\.purchaseOrder\.create\(\{ data: \{ tenantId, supplier, vendorId: vendor\?\.id \?\? null,/);
  assert.match(action, /tx\.purchaseOrderLine\.create\(\{\s*data: \{\s*tenantId,/);
  assert.match(action, /Array\.from\(\{ length: line\.qty \}, \(\) => \(\{\s*tenantId,/);
});

test("the supplier is checked against the workspace on upload and carried to a new version", () => {
  const actions = readFileSync(new URL("../src/app/actions/documents.ts", import.meta.url), "utf8");
  assert.match(actions, /async function chosenVendorId\(/);
  assert.match(actions, /vendorId: old\.vendorId/);
});
