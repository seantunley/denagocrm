import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import Module, { createRequire } from "node:module";
import { jobCardPrintFields, type JobCardPrintSource } from "../src/lib/docbuilder/jobCardFields";
import { standardTemplateFor } from "../src/lib/doceditor/standardTemplates";
import { renderDocumentHtml, type RenderCtx } from "../src/lib/doceditor/serialize";

/**
 * The job card moving to the single document editor, behind a SAFE SWITCH:
 * nothing changes for printing or e-signing until the jobcard layout is
 * published. The switch itself (publishedBuilderTemplateFor) is exercised
 * against a fake store; the two call sites are held to it as source contracts,
 * since a page and a server action cannot be loaded by node --test.
 */

const root = path.join(__dirname, "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

// ── the gate ─────────────────────────────────────────────────────────────────
type Loader = (this: unknown, request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
type FakeTemplate = { id: string; name: string; publishedVersion: number | null; data: unknown } | null;
let fakeDefaultId: string | null = null;
let fakeLive: FakeTemplate = null;
const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only") return {};
  if ((request === "./store" || request === "@/lib/docbuilder/store") && parent?.filename?.endsWith("published.ts")) {
    return {
      defaultBuilderTemplateId: async () => fakeDefaultId,
      getLiveBuilderTemplate: async (id: string) => (fakeLive && fakeLive.id === id ? fakeLive : null),
    };
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;
const { publishedBuilderTemplateFor } = createRequire(__filename)(
  "../src/lib/docbuilder/published.ts",
) as typeof import("../src/lib/docbuilder/published");

test("gate: an unpublished jobcard layout keeps the old renderer (null)", async () => {
  fakeDefaultId = "t1";
  fakeLive = { id: "t1", name: "Job card", publishedVersion: null, data: standardTemplateFor("jobcard") };
  assert.equal(await publishedBuilderTemplateFor("jobcard"), null);
  fakeDefaultId = null;
  assert.equal(await publishedBuilderTemplateFor("jobcard"), null, "no template at all");
});

test("gate: a published jobcard layout switches to the builder", async () => {
  fakeDefaultId = "t1";
  fakeLive = { id: "t1", name: "Job card", publishedVersion: 3, data: standardTemplateFor("jobcard") };
  const live = await publishedBuilderTemplateFor("jobcard");
  assert.ok(live);
  assert.equal(live.id, "t1");
});

test("print page: builder only when published AND readable, never for an old ?tpl= preview", () => {
  // publishedJobCardLayout = the shared switch + a readable document. The page
  // and the renderer both use it, so an unreadable published layout keeps the
  // old page instead of bouncing between the two routes.
  const render = src("src/lib/jobCardPrintDocument.ts");
  assert.match(render, /publishedBuilderTemplateFor\("jobcard"\);\s+if \(!live\) return null;\s+const read = readTemplateDocument\(live\.data, live\.name\);\s+return read\.status === "ok" \? \{ \.\.\.live, doc: read\.doc \} : null;/);
  assert.match(render, /const live = await publishedJobCardLayout\(\);/);
  const page = src("src/app/(print)/jobcards/[id]/print/page.tsx");
  const gate = page.indexOf("if (!tplId && (await publishedJobCardLayout()))");
  assert.ok(gate > 0, "the page decides through the shared helper");
  assert.ok(gate > page.indexOf("requireJobCardReadAccess(id)"), "access is checked before anything else");
  assert.ok(gate < page.indexOf('getDocTemplate("jobcard"'), "the switch runs before the old renderer");
  assert.match(page.slice(gate, gate + 250), /redirect\(`\/jobcards\/\$\{id\}\/print\/document/);
  const route = src("src/app/(print)/jobcards/[id]/print/document/route.ts");
  assert.ok(route.indexOf("requireJobCardReadAccess(id)") < route.indexOf("renderJobCardPrintHtml("));
  assert.match(route, /isModuleEnabled\("automotive"\)/, "no layout guards a route handler");
  // Uploaded images embedded against the job card's workspace; logo via bindCtx.
  assert.match(render, /embedDocImages\(live\.doc, owner\?\.tenantId \?\? undefined\)/);
  assert.match(render, /renderDocumentHtml\(doc, ctx,/);
});

/**
 * Job-card read access is NOT permission to see an unpublished builder draft
 * (that needs docbuilder.view/manage). The document route has no preview
 * parameter at all: it takes no template id from the URL and only ever renders
 * the PUBLISHED layout. If a preview is ever added here, it must gate on
 * docbuilder.view/manage — this test is the reminder.
 */
test("the job card document route cannot be steered to an unpublished draft", () => {
  const route = src("src/app/(print)/jobcards/[id]/print/document/route.ts");
  const render = src("src/lib/jobCardPrintDocument.ts");
  assert.doesNotMatch(route, /searchParams\.get\("(?!photos")/, "the only query parameter read is photos");
  assert.doesNotMatch(route + render, /getBuilderTemplate\(|templateId/, "no draft or chosen-template path");
});

test("e-signing: job cards use the published layout only; otherwise the standard one", () => {
  const action = src("src/app/actions/recordSigning.ts");
  assert.match(action, /\(await publishedBuilderTemplateFor\("jobcard"\)\)\?\.id \?\? null/);
  assert.match(action, /defaultBuilderTemplateId\("quote"\)/, "quotes are unchanged");
  const envelope = src("src/lib/signing/autoEnvelope.ts");
  assert.match(envelope, /getLiveBuilderTemplate\(templateId\)/);
  assert.match(envelope, /quoteId \? standardQuoteTemplate\(\) : standardJobCardTemplate\(\)/);
});

// ── context fields ───────────────────────────────────────────────────────────
const JC: JobCardPrintSource = {
  status: "repair",
  openedAt: new Date("2026-09-01T08:00:00Z"),
  completedAt: new Date("2026-09-03T08:00:00Z"),
  kmIn: 1234,
  notes: "Customer waiting",
  signedAt: null,
  signedByName: null,
  signerIp: null,
  vehicle: { model: "Denago Rover", color: "Blue", vin: "VIN123", regNumber: null },
  serviceRecord: {
    summary: "Brake service",
    details: "Pads replaced",
    km: 1300,
    nextDueDate: new Date("2027-03-01T08:00:00Z"),
    nextDueKm: 5000,
    performedBy: { name: "Tech Tom" },
  },
};

test("job-card context says what the printout says", () => {
  const { tokens, vars } = jobCardPrintFields(JC);
  assert.equal(tokens["vehicle.title"], "Denago Rover — Blue");
  assert.match(tokens["vehicle.lines"], /^VIN \/ Serial: VIN123\nOpened .+ · 1\D?234 km in · Completed /);
  assert.doesNotMatch(tokens["vehicle.lines"], /Reg:/, "an absent reg is left out, as on the printout");
  assert.match(tokens["service.line"], /^Brake service · at 1\D?300 km · Technician: Tech Tom$/);
  assert.match(tokens["service.nextDue"], / \/ 5\D?000 km$/);
  assert.equal(tokens["jobcard.signature"], "", "no signature before signing");
  assert.equal(tokens["jobcard.signedLine"], "");
  assert.ok(tokens["jobcard.stage"]);
  assert.deepEqual(vars, { signed: false, hasNotes: true, hasService: true, hasServiceDetails: true });

  const signed = jobCardPrintFields(
    { ...JC, signedAt: new Date("2026-09-03T09:00:00Z"), signedByName: "Jane", signerIp: "1.2.3.4" },
    "data:image/png;base64,AAAA",
  );
  assert.match(signed.tokens["jobcard.signedLine"], /^Signed electronically by Jane on .+ · IP 1\.2\.3\.4 · ECT Act, 2002$/);
  assert.equal(signed.tokens["jobcard.signature"], "data:image/png;base64,AAAA");
  assert.equal(signed.vars.signed, true);
});

function render(jc: JobCardPrintSource, signatureSrc?: string, other = 0): string {
  const { tokens, vars } = jobCardPrintFields(jc, signatureSrc);
  const ctx: RenderCtx = {
    tokens: { ...tokens, "jobcard.number": "#42", "jobcard.description": "Squeaky brakes", "jobcard.notes": jc.notes ?? "", "customer.name": "Jane Doe" },
    items: [],
    vars: { jobcard: { ...vars, other } },
    bound: true,
  };
  return renderDocumentHtml(standardTemplateFor("jobcard"), ctx, undefined, { hideOverlays: true });
}

test("the seeded jobcard layout renders the printout's sections, conditionally", () => {
  const unsigned = render(JC);
  for (const s of ["JOB CARD", "#42", "WORK REQUESTED", "Squeaky brakes", "SERVICE RECORD", "Brake service", "Pads replaced", "NOTES", "Customer waiting", "Technician signature · Date", "Customer signature · Date"]) {
    assert.ok(unsigned.includes(s), `missing ${s}`);
  }
  assert.doesNotMatch(unsigned, /Other:/, "Other shows only when non-zero");
  assert.doesNotMatch(unsigned, /<img src="data:/);

  const bare = render({ ...JC, notes: null, serviceRecord: null }, undefined, 12.5);
  assert.doesNotMatch(bare, /SERVICE RECORD|NOTES/);
  assert.match(bare, /Other:/);

  const signed = render({ ...JC, signedAt: new Date(), signedByName: "Jane" }, "data:image/png;base64,AAAA");
  assert.match(signed, /<img src="data:image\/png;base64,AAAA"/, "the stored signature is embedded");
  assert.match(signed, /Signed electronically by Jane/);
  assert.doesNotMatch(signed, /Customer signature · Date/);
});

test("an image whose token does not resolve renders nothing", () => {
  const html = render({ ...JC, signedAt: new Date(), signedByName: "Jane" });
  assert.doesNotMatch(html, /\{\{jobcard\.signature\}\}/);
});
