import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildWarrantyCertificateContext, certificateFileName, certificateNumber, partsLines, CERTIFICATE_TAG } from "../src/lib/warrantyCertificate";
import { coverOf } from "../src/lib/warrantyParts";
import { standardTemplateFor, STANDARD_TEMPLATE_KEYS } from "../src/lib/doceditor/standardTemplates";
import { DOC_DEFS, docKeyAvailable } from "../src/lib/docTemplates";
import { SYSTEM_TAG_LABELS } from "../src/lib/documentLabels";

/**
 * Sean, 2026-11-21: "Certificate can be generated at time of delivery and filed to the customer record. It must be
 * professional with the logos and details. A certificate sort of feel." Generated and filed at delivery; sent only on a
 * person's click (decided the same day).
 */
const code = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
const day = (iso: string) => new Date(`${iso}T00:00:00`);
const cover = coverOf([{ part: "Battery", months: 60 }, { part: "Cart", months: 24 }, { part: "Chassis", months: null }], day("2026-11-21"), day("2026-11-21"));
const vehicle = {
  id: "veh_abc7f3k2a", model: "Nomad XL", vin: "VIN123", regNumber: "CA 123-456", color: "Arctic white",
  contact: { firstName: "Sipho", lastName: "Dlamini", phone: "082 555 0101", email: "sipho@example.com", address: "1 Main Rd", suburb: "Constantia", city: "Cape Town" },
};

test("the certificate's fields: number, owner, vehicle, cover from the delivery day, each part on its own line", () => {
  const ctx = buildWarrantyCertificateContext(vehicle, cover, day("2026-11-21"), day("2026-11-21"));
  assert.equal(ctx.tokens["certificate.number"], "WCERT-7F3K2A-2611");
  assert.equal(ctx.tokens["customer.name"], "Sipho Dlamini");
  assert.equal(ctx.tokens.vehicle, "Nomad XL");
  assert.match(ctx.tokens["vehicle.lines"], /VIN: VIN123\nRegistration: CA 123-456\nColour: Arctic white/);
  const parts = ctx.tokens["warranty.partsLines"].split("\n");
  assert.equal(parts.length, 3);
  assert.match(parts[0], /^Battery · 5 years · until /);
  assert.match(parts[1], /^Cart · 2 years · until /);
  assert.equal(parts[2], "Chassis · Lifetime");
  assert.equal(partsLines([]), "");
  assert.equal(certificateNumber("x", day("2027-03-02")), "WCERT-X-2703");
  assert.equal(certificateFileName(vehicle, "N"), "Warranty certificate — Nomad XL CA 123-456.pdf");
  assert.equal(certificateFileName({ model: "Rover/XL", regNumber: null, vin: null }, "WCERT-1"), "Warranty certificate — Rover XL WCERT-1.pdf");
});

test("an editable, branded layout in Document Studio — the Warranty module's; filed with a label set by the CRM", () => {
  assert.ok(STANDARD_TEMPLATE_KEYS.includes("warranty-certificate"));
  const model = JSON.stringify(standardTemplateFor("warranty-certificate"));
  for (const token of ["certificate.number", "customer.name", "vehicle.lines", "warranty.partsLines", "warranty.start", "company.name"]) {
    assert.ok(model.includes(`{{${token}}}`), token);
  }
  assert.match(model, /"type":"banner"[^}]*"title":"WARRANTY CERTIFICATE"|"title":"WARRANTY CERTIFICATE"/);
  assert.match(model, /"type":"footer"/);
  assert.equal(DOC_DEFS["warranty-certificate"].module, "warranty");
  assert.equal(docKeyAvailable("warranty-certificate", new Set(["automotive"])), false, "Warranty off: no certificate");
  assert.equal(docKeyAvailable("warranty-certificate", new Set(["automotive", "warranty"])), true);
  assert.equal(SYSTEM_TAG_LABELS[CERTIFICATE_TAG], "Warranty certificate");
});

test("issued from the published layout (else the standard), filed on the customer AND the vehicle, earlier ones marked replaced", () => {
  const store = code("src/lib/warrantyCertificateStore.ts");
  assert.match(store, /if \(!\(await isModuleEnabled\("warranty"\)\)\) return null;/);
  assert.match(store, /\(await printableRecordLayout\(CERTIFICATE_TAG\)\) \?\? standardTemplateFor\("warranty-certificate"\)/);
  assert.match(store, /renderModelToPdf\(layout, ctx, tenantId\)/, "the workspace's own logo and details");
  assert.match(store, /tenantId, contactId: vehicle\.contactId, vehicleId: vehicle\.id, fileName, storedName,\s*mimeType: "application\/pdf", sizeBytes: pdf\.length, tag: CERTIFICATE_TAG/);
  assert.match(store, /where: \{ tenantId, vehicleId: vehicle\.id, tag: CERTIFICATE_TAG, deletedAt: null, replacedById: null, NOT: \{ id: doc\.id \} \},\s*data: \{ replacedById: doc\.id \}/);
  assert.match(store, /await deleteFile\(storedName\)\.catch/, "a failed filing leaves no orphan file");
  assert.doesNotMatch(store, /sendEmail|sendSms|sendWhatsApp/, "issuing never sends");
});

test("at delivery: after the delivery commits, for each delivered vehicle — and a failure never fails the delivery", () => {
  const delivery = code("src/lib/quoteDelivery.ts");
  assert.match(delivery, /await issueCertificatesAtDelivery\(tenantId, vehicleIds, actor\);/);
  assert.ok(delivery.indexOf("issueCertificatesAtDelivery(tenantId") > delivery.indexOf("return ids;"), "after the transaction");
  assert.match(code("src/app/actions/vehicles.ts"), /if \(deliveryQuoteId\) \{[\s\S]{0,200}issueCertificatesAtDelivery\(vehicle\.tenantId, \[vehicle\.id\], user\)/);
  const store = code("src/lib/warrantyCertificateStore.ts");
  assert.match(store, /catch \(error\) \{\s*await logError\("warranty-certificate", error,/);
  const action = code("src/app/actions/warrantyParts.ts");
  const issue = action.slice(action.indexOf("export async function issueVehicleCertificate"), action.indexOf("export async function saveVehicleWarranty"));
  assert.match(issue, /requireVehicleAccess\(vehicleId, "warranty\.manage"\)/);
});
