import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderDocumentHtml } from "../src/lib/doceditor/serialize";
import { parseDocument } from "../src/lib/doceditor/model";
import { standardTemplateFor } from "../src/lib/doceditor/standardTemplates";
import { deliveryNoteContext, serviceReportContext } from "../src/lib/docbuilder/deliveryServiceContext";
import { guidedEntryDetail, handoverChecklistHtml, type HandoverData } from "../src/lib/doceditor/handoverChecklist";

const src = (p: string) => readFileSync(p, "utf8");
const PNG = "data:image/png;base64,iVBORw0KGgo=";

/* ── the safe switch ─────────────────────────────────────────────────────── */

test("the published gate: only a default template with publishedVersion counts", () => {
  const code = src("src/lib/docbuilder/published.ts");
  assert.match(code, /defaultBuilderTemplateId\(key\)/);
  assert.match(code, /template && template\.publishedVersion != null \? template : null/);
});

test("the layout resolver: ?tpl= previews only a builder template of the same type, else published-or-nothing", () => {
  const code = src("src/lib/deliveryServicePrint.ts");
  const fn = code.slice(code.indexOf("export async function builderLayoutFor"), code.indexOf("export async function printPathBlocked"));
  assert.match(fn, /if \(template\?\.key !== key\) return null;/, "a legacy DocTemplateRecord id stays with the old renderer");
  assert.match(fn, /template = await publishedBuilderTemplateFor\(key\);/);
});

test("a record reader without Builder access cannot render an unpublished draft via ?tpl=", () => {
  const code = src("src/lib/deliveryServicePrint.ts");
  const fn = code.slice(code.indexOf("export async function builderLayoutFor"), code.indexOf("export async function printPathBlocked"));
  // The permission check discards tpl BEFORE any draft is read…
  const check = fn.indexOf("if (tplId && !(await canPreviewBuilderDraft())) tplId = null;");
  assert.ok(check > 0, "?tpl= is ignored without Builder permission");
  assert.ok(check < fn.indexOf("getBuilderTemplate(tplId)"), "checked before the draft is loaded");
  // …and the check is the Builder permission, not the record access the caller already has.
  assert.match(fn, /hasAnyPermission\(user, "docbuilder\.view", "docbuilder\.manage"\)/);
  assert.match(fn, /return !!user && /, "no session, no draft");
  // Nothing else on these print paths reads a draft directly.
  for (const f of [
    "src/app/(print)/quotes/[id]/delivery-note/page.tsx",
    "src/app/(print)/quotes/[id]/delivery-note/document/route.ts",
    "src/app/(print)/jobcards/[id]/service-report/page.tsx",
    "src/app/(print)/jobcards/[id]/service-report/document/route.ts",
  ]) {
    assert.doesNotMatch(src(f), /getBuilderTemplate\(/, `${f} must go through builderLayoutFor`);
  }
});

for (const [page, key, route] of [
  ["src/app/(print)/quotes/[id]/delivery-note/page.tsx", "delivery", "delivery-note/document"],
  ["src/app/(print)/jobcards/[id]/service-report/page.tsx", "service-report", "service-report/document"],
] as const) {
  test(`${key}: the page switches only when a builder layout is resolved, before the fixed layout renders`, () => {
    const code = src(page);
    const gate = code.indexOf(`if (await builderLayoutFor("${key}", tplId))`);
    assert.ok(gate > 0, "gated on builderLayoutFor");
    assert.ok(code.indexOf(`redirect(`, gate) > gate && code.indexOf(route, gate) > gate, "redirects to the document route");
    assert.ok(gate < code.indexOf("getDocTemplate("), "the gate runs before the legacy template is read");
    // Access is checked before anything is revealed about the layout.
    assert.ok(code.indexOf("Access(id)") < gate);
  });
}

for (const [route, access] of [
  ["src/app/(print)/quotes/[id]/delivery-note/document/route.ts", "requireQuoteReadAccess(id)"],
  ["src/app/(print)/jobcards/[id]/service-report/document/route.ts", "requireJobCardReadAccess(id)"],
] as const) {
  test(`${route}: binds the workspace, checks access and module, falls back when unpublished`, () => {
    const code = src(route);
    assert.match(code, /return withActingStaffScope\(async \(\) => \{/);
    assert.ok(code.includes(`await ${access}`));
    assert.match(code, /printPathBlocked\(url\.pathname\)/);
    assert.match(code, /if \(!doc\) redirect\(/);
  });
}

test("the delivery document route keeps the automotive guard and hides its toolbar when embedded", () => {
  const code = src("src/app/(print)/quotes/[id]/delivery-note/document/route.ts");
  assert.match(code, /isModuleEnabled\("automotive"\)/);
  assert.match(code, /embedded \? undefined : printToolbarHtml/);
});

/* ── delivery note ───────────────────────────────────────────────────────── */

const quoteBase = () => ({
  tokens: {
    "customer.name": "Lodge Ltd",
    "customer.attention": "Jo Manager",
    "customer.phone": "021 555 0000",
    "customer.address": "1 Vine Rd",
    "quote.number": "Q-12",
    "company.name": "Denago CT",
  },
  items: [
    { cells: [{ value: "Rover XL" }, { value: "2" }, { value: "R 1.00" }, { value: "R 2.00" }] },
    { cells: [{ value: "Delivery fee" }, { value: "1" }, { value: "R 5.00" }, { value: "R 5.00" }] },
  ],
  vars: {},
  bound: true,
});

const handover: HandoverData = {
  runs: [{
    name: "Walkaround",
    completed: "12 Sep 2026",
    entries: [
      { label: "Keys handed over", mark: "done", detail: "Yes", photos: [] },
      { label: "Paint check", mark: "done", detail: "1 photo", photos: [PNG, "javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zz4="] },
      { label: "Manual", mark: "skipped", detail: "Skipped — none in stock", photos: [] },
    ],
  }],
  signature: PNG,
  signedOn: "12 Sep 2026",
};

test("the seeded delivery layout, bound, prints what the fixed note prints", () => {
  const doc = standardTemplateFor("delivery");
  assert.ok(parseDocument(doc));
  const ctx = deliveryNoteContext(quoteBase(), {
    quoteNumber: 12,
    deliveredAt: new Date("2026-09-12T10:00:00Z"),
    deliveryScheduledFor: new Date("2026-09-10T10:00:00Z"),
    deliveredByName: "Sam Driver",
    lineCount: 1,
    handover,
  });
  const html = renderDocumentHtml(doc, ctx);
  assert.doesNotMatch(html, /\{\{/, "no unresolved tokens");
  for (const s of ["DN-12", "Reference: Q-12", "Delivered by: Sam Driver", "Ask for: Jo Manager", "Scheduled: ", "Driver: Sam Driver", "Rover XL", "Walkaround", "Completed 12 Sep 2026", "Keys handed over", "Skipped — none in stock", "Customer signature", "Recorded on 12 Sep 2026"]) {
    assert.ok(html.includes(s), `missing ${s}`);
  }
  assert.doesNotMatch(html, /Delivery fee/, "a delivery note is a packing list, not the priced rows");
  assert.doesNotMatch(html, /Unit price/i);
  // Photos and the signature are embedded; unsafe sources never reach an <img>.
  assert.equal(html.split(`src="${PNG}"`).length - 1, 2);
  assert.doesNotMatch(html, /javascript:|svg\+xml/);
});

test("an undelivered note without guided runs says so and shows the fallback list", () => {
  const ctx = deliveryNoteContext(quoteBase(), {
    quoteNumber: 7, deliveredAt: null, deliveryScheduledFor: null, deliveredByName: null, lineCount: 1,
    handover: { runs: [{ name: null, completed: null, entries: [{ label: "Battery fully charged", mark: "open", detail: null, photos: [] }] }], signature: null, signedOn: null },
  });
  const html = renderDocumentHtml(standardTemplateFor("delivery"), ctx);
  assert.match(html, /Not yet delivered/);
  assert.match(html, /Battery fully charged/);
  assert.doesNotMatch(html, /Customer signature/);
});

test("unbound (editor / no record) the checklist block shows the sample list, never a record's", () => {
  const html = handoverChecklistHtml({ vars: { handover }, bound: false });
  assert.match(html, /Charger &amp; cable handed over/);
  assert.doesNotMatch(html, /Walkaround/);
});

test("guided entry detail matches the fixed layout's wording", () => {
  const e = { captureSnapshot: "photo_note", status: "done", note: " scratch ", value: null, skipReason: null, photos: [1, 2] };
  assert.equal(guidedEntryDetail(e), "2 photos · scratch");
  assert.equal(guidedEntryDetail({ ...e, status: "na", skipReason: null }), "Skipped");
  assert.equal(guidedEntryDetail({ ...e, captureSnapshot: "boolean", value: "false" }), "No");
});

/* ── service report ──────────────────────────────────────────────────────── */

const jobBase = (lines: unknown[]) => ({
  tokens: { "customer.name": "Ann Owner", "customer.phone": "082", "customer.email": "a@x.co", vehicle: "Rover XL", "company.name": "Denago CT" },
  items: [{ cells: [{ value: "Labour — Service" }, { value: "1" }, { value: "R 1.00" }, { value: "R 1.00" }] }],
  vars: { jobcard: { lines } },
  bound: true,
});

const facts = {
  jobCardNumber: 44,
  serviceDate: new Date("2026-09-01T10:00:00Z"),
  completedAt: null,
  technician: "Tess Tech",
  km: 1234,
  vin: "VIN123",
  summary: "Annual service",
  details: "Brakes adjusted",
  nextDueDate: null,
  nextDueKm: 12000,
};

test("the seeded service-report layout, bound, prints what the fixed report prints", () => {
  const doc = standardTemplateFor("service-report");
  assert.ok(parseDocument(doc));
  const html = renderDocumentHtml(doc, serviceReportContext(jobBase([{}]), facts));
  assert.doesNotMatch(html, /\{\{/);
  for (const s of ["SR-44", "Technician: Tess Tech", "Job card #44", "VIN: VIN123", `Odometer: ${(1234).toLocaleString()} km`, "Annual service", "Brakes adjusted", "Labour — Service", "NEXT SERVICE DUE", `${(12000).toLocaleString()} km`]) {
    assert.ok(html.includes(s), `missing ${s}`);
  }
});

test("no summary, no items, no next-due: those sections are left out, as today", () => {
  const html = renderDocumentHtml(
    standardTemplateFor("service-report"),
    serviceReportContext(jobBase([]), { ...facts, summary: null, details: null, nextDueKm: null }),
  );
  assert.doesNotMatch(html, /WORK CARRIED OUT|NEXT SERVICE DUE|Labour — Service/);
});
