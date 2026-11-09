import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { MODULE_REGISTRY, moduleForPath, OPTIONAL_MODULE_IDS } from "../src/lib/modules/registry";
import { SETTINGS_NAV_GROUPS } from "../src/lib/settings-navigation";

/** Suppliers is a module the platform grants or revokes per workspace (Sean, 2026-11-09). */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("suppliers is an optional module owning Settings → Suppliers", () => {
  assert.ok(OPTIONAL_MODULE_IDS.includes("suppliers"));
  assert.equal(MODULE_REGISTRY.find((mod) => mod.id === "suppliers")?.mandatory, undefined);
  assert.equal(moduleForPath("/settings/vendors"), "suppliers");
  assert.equal(moduleForPath("/settings/vendors/abc"), "suppliers");
  const item = SETTINGS_NAV_GROUPS.flatMap((group) => group.items).find((entry) => entry.key === "vendors");
  assert.equal(item?.module, "suppliers");
});

test("every way in refuses or hides when the module is off", () => {
  for (const page of ["src/app/(app)/settings/vendors/page.tsx", "src/app/(app)/settings/vendors/[id]/page.tsx"]) {
    assert.match(read(page), /if \(!\(await isModuleEnabled\("suppliers"\)\)\) notFound\(\);/, page);
  }
  const actions = read("src/app/actions/vendors.ts");
  for (const name of ["saveVendor", "deleteVendor"]) {
    const body = actions.slice(actions.indexOf(`export async function ${name}(`));
    assert.ok(body.indexOf("await requireSuppliers();") < body.indexOf("prisma."), `${name} checks the module before any write`);
  }
  assert.match(actions, /async function dealQuote\(quoteId: string\) \{\s*const user = await requireQuoteAccess\(quoteId, "documents\.upload"\);\s*await requireSuppliers\(\);/);
  // Documents: no supplier asked for or stored, and the one on file left alone.
  const docs = read("src/app/actions/documents.ts");
  assert.match(docs, /if \(!\(await isModuleEnabled\("suppliers"\)\)\) return undefined;/);
  assert.match(docs, /async function dealSupplierFrom\([^)]*\) \{\s*if \(!\(await isModuleEnabled\("suppliers"\)\)\) return;/);
  // Deal page, documents panel, purchase orders, search and DAX all read the module.
  // The deal file is read through the shared loader (the page and the ZIP download alike).
  assert.match(read("src/lib/dealFileData.ts"), /const suppliersOn = await isModuleEnabled\("suppliers"\);/);
  assert.match(read("src/app/(app)/deals/[id]/page.tsx"), /\{suppliersOn && <>/);
  assert.match(read("src/components/DocumentsPanel.tsx"), /const vendors = \(await isModuleEnabled\("suppliers"\)\)/);
  assert.match(read("src/app/actions/stock.ts"), /if \(await isModuleEnabled\("suppliers"\)\) \{\s*vendor = await prisma\.vendor\.findFirst/);
  assert.match(read("src/app/actions/stock.ts"), /const supplier = vendor\?\.name \?\? str\(formData\.get\("supplier"\)\);/);
  assert.match(read("src/components/StockPurchaseOrderForm.tsx"), /<input name="supplier" className="input" required \/>/);
  assert.match(read("src/lib/crmSearch.ts"), /\.\.\.\(suppliersOn \? \[\{ vendor: \{ is: \{ name: contains \} \} \}\] : \[\]\)/);
  // DAX asks for and names a supplier only with the module on (since DAX names suppliers, 2026-11-09).
  assert.match(read("src/lib/crmAssistant.ts"), /\(supplierType \|\| p\.supplier\) && \(await isModuleEnabled\("suppliers"\)\)/);
});

test("module off: the checklist names the document type, never a supplier box that isn't there (review of #1043)", async () => {
  const { dealFileChecklist } = await import("../src/lib/dealFile");
  const { DEFAULT_DOCUMENT_TYPES } = await import("../src/lib/documentLabels");
  const quote = { number: 1, status: "sent", invoicedAt: null, deliverySignatureRef: null };
  const off = dealFileChecklist([quote], [], DEFAULT_DOCUMENT_TYPES, [], false).filter((item) => item.label.startsWith("Supplier"));
  assert.ok(off.length > 0);
  for (const item of off) assert.doesNotMatch(item.detail, /supplier chosen|as the supplier/, item.label);
  assert.match(off[0].detail, /Upload it as “Supplier quote”/);
  assert.match(read("src/lib/dealFileData.ts"), /declaredVendors,\s*suppliersOn,\s*\);/);
});

test("existing workspaces are granted it, once, so nothing they use disappears", () => {
  const sql = read("prisma/migrations/20261109200000_grant_suppliers_module/migration.sql");
  assert.match(sql, /UPDATE "Tenant"/);
  assert.match(sql, /WHERE NOT \('suppliers' = ANY/);
});
