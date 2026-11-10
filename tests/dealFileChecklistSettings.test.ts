import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  dealFileChecklist, DEFAULT_DEAL_FILE_CONFIG, isSupplierOnlyType, mayBeSupplierPaper, parseDealFileConfig, partiesOf,
  supplierDocumentTypes, tickedTypes, typesForSupplier, type DealFileConfig,
} from "../src/lib/dealFile";
import { DEFAULT_DOCUMENT_TYPES } from "../src/lib/documentLabels";

// Sean, 2026-11-10: the deal file's lists are the owner's to change — "different documents per supplier and the lists".
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const quote = { number: 1029, status: "sent", invoicedAt: null, deliverySignatureRef: null };
const types = [...DEFAULT_DOCUMENT_TYPES, "Wrap certificate"];

test("nothing saved, or something unreadable, is today's checklist", () => {
  assert.deepEqual(parseDealFileConfig(null), DEFAULT_DEAL_FILE_CONFIG);
  assert.deepEqual(parseDealFileConfig("not json"), DEFAULT_DEAL_FILE_CONFIG);
  assert.deepEqual(parseDealFileConfig('{"builtins":["quote","nonsense"],"dealTypes":["ID document","ID document"]}'), {
    builtins: ["quote"],
    dealTypes: ["ID document"],
    supplierTypes: DEFAULT_DEAL_FILE_CONFIG.supplierTypes,
  });
});

test("a supplier-only type ticked under 'Every deal needs' is not a deal-wide line that can never tick (Sean, 2026-11-10)", () => {
  // The setting as saved on prod: supplier invoice + proof of payment ticked in BOTH lists.
  const saved = '{"builtins":["quote"],"dealTypes":["Supplier invoice","Proof of payment — supplier","ID document"],"supplierTypes":["Supplier invoice","Proof of payment — supplier"]}';
  const config = parseDealFileConfig(saved);
  assert.deepEqual(config.dealTypes, ["ID document"]);
  const items = dealFileChecklist([quote], [
    { tag: "Supplier invoice", vendorId: "jet", vendorName: "Jetman Distributors" },
    { tag: "Proof of payment — supplier", vendorId: "jet", vendorName: "Jetman Distributors" },
  ], types, config);
  assert.deepEqual(items.map((item) => [item.label, item.done]), [
    ["Quote", true], ["ID document", false],
    ["Supplier invoice — Jetman Distributors", true], ["Proof of payment — supplier — Jetman Distributors", true],
  ]);
  // The form does not offer them there either.
  assert.match(read("src/app/(app)/settings/page.tsx"), /documentTypes\.filter\(\(type\) => !isSupplierOnlyType\(type\)\)\.map\(\(type\) => \(\s*<label key=\{type\} className="flex items-center gap-2 text-sm">\s*<input type="checkbox" name="dealType"/);
});

test("the owner's lists decide the deal's lines, and a supplier's own list replaces the default for it", () => {
  const config: DealFileConfig = { builtins: ["quote", "delivery"], dealTypes: ["ID document"], supplierTypes: ["Supplier invoice"] };
  const items = dealFileChecklist([quote], [], types, config, [
    { id: "oem", name: "Denago", requiredDocuments: null },
    { id: "wrap", name: "Wrap Studio", requiredDocuments: ["Supplier quote", "Wrap certificate"] },
    { id: "transport", name: "Fast Freight", requiredDocuments: [] },
  ]);
  assert.deepEqual(items.map((item) => item.label), [
    "Quote", "Delivery paperwork", "ID document",
    "Supplier invoice — Denago",
    "Supplier quote — Wrap Studio", "Wrap certificate — Wrap Studio",
  ]);
  assert.deepEqual(items.find((item) => item.label === "Wrap certificate — Wrap Studio")?.supplier, { vendorId: "wrap", documentType: "Wrap certificate" });
  assert.equal(items.find((item) => item.label === "ID document")?.supplier, undefined, "a deal line is not a supplier's");
});

test("a supplier named only on a document brings its own list too; no supplier → the default list, unnamed", () => {
  const config: DealFileConfig = { builtins: [], dealTypes: [], supplierTypes: ["Supplier invoice"] };
  const named = dealFileChecklist([quote], [{ tag: "Wrap certificate", vendorId: "wrap", vendorName: "Wrap Studio", vendorRequiredDocuments: ["Wrap certificate"] }], types, config);
  assert.deepEqual(named.map((item) => [item.label, item.done]), [["Wrap certificate — Wrap Studio", true]]);
  const none = dealFileChecklist([quote], [], types, config);
  assert.deepEqual(none.map((item) => [item.label, item.supplier?.vendorId]), [["Supplier invoice", null]]);
});

test("a type on a supplier list only OFFERS the supplier box; one whose name says supplier requires it", () => {
  const all = supplierDocumentTypes(DEFAULT_DEAL_FILE_CONFIG, [["Wrap certificate", "supplier quote"], null, "junk"]);
  assert.deepEqual(all, ["Supplier quote", "Supplier invoice", "Proof of payment — supplier", "Wrap certificate"]);
  assert.equal(mayBeSupplierPaper("wrap certificate", all), true);
  assert.equal(mayBeSupplierPaper("ID document", all), false);
  assert.equal(isSupplierOnlyType("Supplier invoice"), true);
  assert.equal(isSupplierOnlyType("Wrap certificate"), false, "a custom type never forces a supplier");
  assert.deepEqual(typesForSupplier(DEFAULT_DEAL_FILE_CONFIG, []), [], "its own empty list = nothing asked");
  assert.deepEqual(typesForSupplier(DEFAULT_DEAL_FILE_CONFIG, null), DEFAULT_DEAL_FILE_CONFIG.supplierTypes);
  assert.deepEqual(tickedTypes(["Wrap certificate", "Typed in", "ID document"], types), ["ID document", "Wrap certificate"]);
});

test("review of #1059: one supplier asked for an ID document does not make the customer's ID a supplier's", () => {
  // A transport company's own list asks for an ID document.
  const config: DealFileConfig = { builtins: [], dealTypes: ["ID document"], supplierTypes: [] };
  const docs = [
    { tag: "ID document", vendorId: null, vendorName: null },
    { tag: "ID document", vendorId: "fast", vendorName: "Fast Freight", vendorRequiredDocuments: ["ID document"] },
  ];
  const items = dealFileChecklist([quote], docs, types, config, [{ id: "fast", name: "Fast Freight", requiredDocuments: ["ID document"] }]);
  assert.deepEqual(items.map((item) => [item.label, item.done]), [["ID document", true], ["ID document — Fast Freight", true]]);
  // Only the supplier's copy: the customer's line stays missing — a supplier's paper never ticks the customer's box.
  const supplierOnly = dealFileChecklist([quote], [docs[1]], types, config, [{ id: "fast", name: "Fast Freight", requiredDocuments: ["ID document"] }]);
  assert.deepEqual(supplierOnly.map((item) => [item.label, item.done]), [["ID document", false], ["ID document — Fast Freight", true]]);
  // Grouping by the supplier the document NAMES: the customer's ID stays the customer's.
  const sections = partiesOf([{ id: "1", tag: "ID document", vendor: null }, { id: "2", tag: "ID document", vendor: { id: "fast", name: "Fast Freight" } }]);
  assert.deepEqual(sections.map((s) => [s.label, s.docs.map((d) => d.id)]), [["Customer", ["1"]], ["Supplier · Fast Freight", ["2"]]]);
  // Upload: only a type whose name says supplier refuses a missing supplier.
  assert.match(read("src/app/actions/documents.ts"), /if \(isSupplierOnlyType\(type\)\) refuse\("Choose which supplier it is from/);
  assert.match(read("src/lib/crmAssistant.ts"), /const supplierType = label !== null && isSupplierOnlyType\(label\);/);
  assert.doesNotMatch(read("src/lib/dealFile.ts"), /export function partiesOf<[^(]*\(\s*docs: T\[\],\s*supplierTypes/, "grouping takes no type list");
});

test("every reader asks with the workspace's lists, not the old fixed three", () => {
  assert.match(read("src/app/actions/documentRequests.ts"), /typesForSupplier\(await getDealFileConfig\(\), vendor\.requiredDocuments\)/);
  const panel = read("src/components/DocumentsPanel.tsx");
  assert.match(panel, /const supplierTypes = await workspaceSupplierTypes\(tenantId\);/);
  assert.match(read("src/lib/dealFileData.ts"), /getDealFileConfig\(\),/);
  assert.match(read("src/lib/supplierDigest.ts"), /filter\(\(item\) => !item\.done && item\.supplier\?\.vendorId\)/);
  assert.match(read("src/app/(app)/deals/[id]/page.tsx"), /documentType: item\.supplier\.documentType/);
  assert.match(read("src/app/(app)/settings/vendors/[id]/page.tsx"), /const asked = typesForSupplier\(config, vendor\.requiredDocuments\);/);
});

test("saving: owner only, from the list only, audited — the defaults and a supplier's own list apart", () => {
  const settings = read("src/app/actions/settings.ts");
  const save = settings.slice(settings.indexOf("export async function saveDealFileChecklist("));
  assert.match(save, /const user = await requireTenantOwner\(\);/);
  assert.match(save, /tickedTypes\(formData\.getAll\("dealType"\), types\)/);
  assert.match(save, /action: "settings\.deal_file_checklist"/);
  const vendors = read("src/app/actions/vendors.ts");
  const own = vendors.slice(vendors.indexOf("export async function saveVendorRequiredDocuments("));
  assert.match(own, /requireTenantOwner\(\);\s*await requireSuppliers\(\);/);
  assert.match(own, /where: \{ id, tenantId, deletedAt: null \},\s*data: \{ requiredDocuments: list === null \? Prisma\.DbNull : list \}/);
  assert.match(own, /action: "vendor\.required_documents"/);
  assert.match(read("prisma/migrations/20261110030000_vendor_required_documents/migration.sql"), /ADD COLUMN IF NOT EXISTS "requiredDocuments" JSONB;/);
});
