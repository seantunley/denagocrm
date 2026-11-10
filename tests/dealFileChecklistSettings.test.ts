import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  dealFileChecklist, DEFAULT_DEAL_FILE_CONFIG, isSupplierDocumentType, parseDealFileConfig, supplierDocumentTypes,
  tickedTypes, typesForSupplier, type DealFileConfig,
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

test("a supplier's paper is any type on any supplier list — and only types from the Document types list are saved", () => {
  const all = supplierDocumentTypes(DEFAULT_DEAL_FILE_CONFIG, [["Wrap certificate", "supplier quote"], null, "junk"]);
  assert.deepEqual(all, ["Supplier quote", "Supplier invoice", "Proof of payment — supplier", "Wrap certificate"]);
  assert.equal(isSupplierDocumentType("wrap certificate", all), true);
  assert.equal(isSupplierDocumentType("ID document", all), false);
  assert.deepEqual(typesForSupplier(DEFAULT_DEAL_FILE_CONFIG, []), [], "its own empty list = nothing asked");
  assert.deepEqual(typesForSupplier(DEFAULT_DEAL_FILE_CONFIG, null), DEFAULT_DEAL_FILE_CONFIG.supplierTypes);
  assert.deepEqual(tickedTypes(["Wrap certificate", "Typed in", "ID document"], types), ["ID document", "Wrap certificate"]);
});

test("every reader asks with the workspace's lists, not the old fixed three", () => {
  const dealFile = read("src/lib/dealFile.ts");
  assert.match(dealFile, /export const isSupplierDocumentType = \(tag: string \| null \| undefined, supplierTypes: readonly string\[\]\)/, "the list is required");
  assert.match(read("src/app/actions/documents.ts"), /isSupplierDocumentType\(type, await workspaceSupplierTypes\(tenantId\)\)/);
  assert.match(read("src/lib/crmAssistant.ts"), /isSupplierDocumentType\(label, await workspaceSupplierTypes\(await actingTenantId\(\)\)\)/);
  assert.match(read("src/app/actions/documentRequests.ts"), /typesForSupplier\(await getDealFileConfig\(\), vendor\.requiredDocuments\)/);
  const panel = read("src/components/DocumentsPanel.tsx");
  assert.match(panel, /const supplierTypes = await workspaceSupplierTypes\(tenantId\);/);
  assert.match(panel, /partiesOf\([\s\S]{0,200}, supplierTypes\)/);
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
