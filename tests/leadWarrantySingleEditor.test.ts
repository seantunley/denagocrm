import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Module, { createRequire } from "node:module";

import { buildLeadContext, buildWarrantyContext } from "../src/lib/docbuilder/leadWarrantyContext";
import { standardTemplateFor } from "../src/lib/doceditor/standardTemplates";
import { renderDocumentHtml } from "../src/lib/doceditor/serialize";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * The server modules are `server-only` and reach Prisma (a live client against
 * DATABASE_URL — production, in a checkout with a .env). Everything that touches
 * the database is stubbed at the loader so the REAL gate logic runs here.
 */
const store = {
  defaultId: null as string | null,
  live: null as null | { id: string; name: string; data: unknown; publishedVersion: number | null },
};
const published = { template: null as null | { name: string; data: unknown } };

type Loader = (request: string, parent: NodeJS.Module | undefined, isMain: boolean) => unknown;
const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
const from = (parent: NodeJS.Module | undefined, file: string) =>
  (parent?.filename ?? "").replace(/\\/g, "/").endsWith(file);
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only" || request === "client-only") return {};
  if (from(parent, "src/lib/docbuilder/published.ts") && request === "./store") {
    return {
      defaultBuilderTemplateId: async () => store.defaultId,
      getLiveBuilderTemplate: async (id: string) => (store.live?.id === id ? store.live : null),
    };
  }
  if (from(parent, "src/lib/docbuilder/leadWarrantyRecords.ts")) {
    if (request === "./published") return { publishedBuilderTemplateFor: async () => published.template };
    if (request === "@/lib/db") return { prisma: {} };
    if (request === "@/lib/companyProfile") return { getCompanyProfile: async () => ({}), companyTokens: () => ({}) };
    if (request === "@/lib/signing/render") return { logoDataUri: () => undefined };
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const load = createRequire(import.meta.url);
const { publishedBuilderTemplateFor } = load("../src/lib/docbuilder/published.ts") as typeof import("../src/lib/docbuilder/published");
const { printableRecordLayout } = load("../src/lib/docbuilder/leadWarrantyRecords.ts") as typeof import("../src/lib/docbuilder/leadWarrantyRecords");

const NOW = new Date("2026-09-29T10:00:00Z");

const lead = {
  title: "Rover XL enquiry",
  name: "Thandi Mokoena",
  phone: "082 555 0101",
  email: null,
  color: "Sky Blue",
  status: "open",
  source: "website",
  product: { name: "Denago Rover XL" },
  contact: null,
};

const claim = {
  id: "clm_000000abcdef",
  status: "approved",
  description: "Charger fault — will not charge past 80%.",
  resolution: null as string | null,
  claimedAt: new Date("2026-09-01T10:00:00Z"),
  resolvedAt: null as Date | null,
  vehicle: {
    model: "Denago Nomad",
    vin: null,
    regNumber: "CA 123-456",
    color: "White",
    purchaseDate: new Date("2026-01-15T10:00:00Z"),
    warrantyMonths: 24,
    contact: { firstName: "Pieter", lastName: "Botha", phone: "083 000 1111", email: "pieter@example.com" },
  },
};

/* ── context builders ───────────────────────────────────────────────── */

test("lead context carries what the indemnity prints", () => {
  const { tokens, items } = buildLeadContext(lead, NOW);
  assert.equal(tokens["customer.name"], "Thandi Mokoena");
  assert.equal(tokens["customer.lines"], "082 555 0101", "a missing email is dropped, not a blank line");
  assert.equal(tokens.vehicle, "Denago Rover XL");
  assert.equal(tokens["vehicle.lines"], "Colour: Sky Blue");
  assert.match(tokens["date.today"], /^29 \S+ 2026$/);
  assert.deepEqual(items, []);

  const bare = buildLeadContext({ ...lead, product: null, color: null }, NOW).tokens;
  assert.equal(bare.vehicle, "Denago EV", "same fallback as the legacy page");
  assert.equal(bare["vehicle.lines"], "");
});

test("warranty context carries what the warranty claim prints", () => {
  const { tokens, vars, items } = buildWarrantyContext(claim, [], NOW);
  assert.equal(tokens["claim.number"], "WC-ABCDEF");
  assert.equal(tokens["claim.status"], "approved");
  assert.equal(tokens["claim.description"], claim.description);
  assert.equal(tokens["customer.name"], "Pieter Botha");
  assert.equal(tokens["customer.lines"], "083 000 1111\npieter@example.com");
  assert.equal(tokens.vehicle, "Denago Nomad");
  const vehicleLines = tokens["vehicle.lines"].split("\n");
  assert.equal(vehicleLines.length, 2, "no VIN line when there is no VIN");
  assert.match(vehicleLines[0], /^Purchased: /);
  assert.match(vehicleLines[1], /^Warranty: .+ \(until /);
  assert.equal((vars.claim as { hasResolution: boolean }).hasResolution, false);
  assert.deepEqual(items, []);

  const resolved = buildWarrantyContext(
    { ...claim, resolution: "Charger replaced.", resolvedAt: new Date("2026-09-10T10:00:00Z") },
    [{ kind: "part", description: "Charger", qty: 1, unitPriceCents: 250000 }],
    NOW,
  );
  assert.match(resolved.tokens["claim.resolutionLine"], /^Charger replaced\. \(.+\)$/);
  assert.equal((resolved.vars.claim as { hasResolution: boolean }).hasResolution, true);
  assert.equal(resolved.items.length, 1);
  assert.equal(resolved.items[0].cells[0].value, "Charger");
});

/* ── seeded layouts, bound ─────────────────────────────────────────── */

const company = { "company.name": "Denago Cape Town" };

test("the seeded indemnity binds to a lead with no placeholder left over", () => {
  const ctx = buildLeadContext(lead, NOW);
  const html = renderDocumentHtml(standardTemplateFor("indemnity"), {
    ...ctx, tokens: { ...company, ...ctx.tokens }, bound: true,
  });
  assert.doesNotMatch(html, /\{\{/);
  for (const text of ["TEST-DRIVE INDEMNITY", "Thandi Mokoena", "Denago Rover XL", "Colour: Sky Blue", "licence number", "INDEMNITY &amp; WAIVER", "Driver signature"]) {
    assert.ok(html.includes(text), `indemnity should show ${text}`);
  }
});

test("the seeded warranty claim binds, and shows a resolution only when there is one", () => {
  const open = buildWarrantyContext(claim, [], NOW);
  const openHtml = renderDocumentHtml(standardTemplateFor("warranty-claim"), {
    ...open, tokens: { ...company, ...open.tokens }, bound: true,
  });
  assert.doesNotMatch(openHtml, /\{\{/);
  for (const text of ["WARRANTY CLAIM", "WC-ABCDEF", "Pieter Botha", "Denago Nomad", "REPORTED FAULT", "Charger fault"]) {
    assert.ok(openHtml.includes(text), `warranty claim should show ${text}`);
  }
  assert.ok(!openHtml.includes("RESOLUTION"), "no resolution box before there is a resolution");

  const done = buildWarrantyContext({ ...claim, resolution: "Charger replaced.", resolvedAt: NOW }, [], NOW);
  const doneHtml = renderDocumentHtml(standardTemplateFor("warranty-claim"), {
    ...done, tokens: { ...company, ...done.tokens }, bound: true,
  });
  assert.ok(doneHtml.includes("RESOLUTION") && doneHtml.includes("Charger replaced."));
});

/* ── the safe switch ───────────────────────────────────────────────── */

const readable = standardTemplateFor("indemnity");

test("publishedBuilderTemplateFor is null until the default template is published", async () => {
  store.defaultId = null;
  store.live = null;
  assert.equal(await publishedBuilderTemplateFor("indemnity"), null, "no template at all");

  store.defaultId = "t1";
  store.live = { id: "t1", name: "Test-drive indemnity", data: readable, publishedVersion: null };
  assert.equal(await publishedBuilderTemplateFor("indemnity"), null, "seeded/autosaved but never published");

  store.live = { ...store.live, publishedVersion: 3 };
  assert.equal((await publishedBuilderTemplateFor("indemnity"))?.id, "t1");
});

test("a print page switches only to a published AND readable layout", async () => {
  published.template = null;
  assert.equal(await printableRecordLayout("indemnity"), null, "unpublished: legacy page");

  published.template = { name: "broken", data: { nonsense: true } };
  assert.equal(await printableRecordLayout("indemnity"), null, "unreadable: legacy page, not a bounce loop");

  published.template = { name: "Test-drive indemnity", data: readable };
  assert.equal((await printableRecordLayout("indemnity"))?.title, readable.title);
});

for (const page of [
  {
    key: "indemnity",
    page: "src/app/(print)/leads/[id]/indemnity/page.tsx",
    route: "src/app/(print)/leads/[id]/indemnity/document/route.ts",
    target: "`/leads/${id}/indemnity/document`",
    back: "`/leads/${id}/indemnity`",
    guard: "requireLeadReadAccess(id)",
  },
  {
    key: "warranty-claim",
    page: "src/app/(print)/warranty/[id]/print/page.tsx",
    route: "src/app/(print)/warranty/[id]/print/document/route.ts",
    target: "`/warranty/${id}/print/document`",
    back: "`/warranty/${id}/print`",
    guard: "requireVehicleReadAccess(claim.vehicleId)",
  },
]) {
  test(`${page.key}: the print page and its document route share one gate, behind the same guard`, () => {
    const pageSrc = src(page.page);
    const gate = `if (!tplId && (await printableRecordLayout("${page.key}"))) {`;
    assert.ok(pageSrc.includes(gate), "legacy page switches only on a published layout, never for a ?tpl= preview");
    assert.ok(pageSrc.includes(`redirect(${page.target})`));
    assert.ok(pageSrc.indexOf(page.guard) < pageSrc.indexOf(gate), "access is checked before anything else");
    assert.ok(pageSrc.includes("<PrintDocShell"), "the legacy render is still there for the unpublished case");

    const routeSrc = src(page.route);
    assert.ok(routeSrc.includes("withActingStaffScope("));
    const guard = routeSrc.indexOf(page.guard);
    const layout = routeSrc.indexOf(`printableRecordLayout("${page.key}")`);
    const render = routeSrc.indexOf("renderRecordDocumentHtml(\n");
    assert.ok(guard !== -1 && guard < layout && layout < render, "guard, then gate, then render");
    assert.ok(routeSrc.includes(`if (!doc) redirect(${page.back});`), "unpublished bounces back to the legacy page");
  });
}

test("the warranty document route keeps the module guard the (print) layout gave the page", () => {
  const routeSrc = src("src/app/(print)/warranty/[id]/print/document/route.ts");
  assert.ok(routeSrc.indexOf('isModuleEnabled("automotive")') < routeSrc.indexOf("findUnique("));
});

test("the builder decides lead and warranty access the way the print pages do", () => {
  const helper = src("src/lib/docbuilder/recordAccess.ts");
  assert.match(helper, /record\.kind === "lead"\) return canAccessLead\(user, record\.id\)/);
  assert.match(helper, /canAccessVehicle\(user, claim\.vehicleId\)/);
  assert.match(helper, /prisma\.warrantyClaim\.findUnique/, "the claim is read through the tenant-scoped client");
  assert.doesNotMatch(helper, /basePrisma/);

  // The editor's preview picker lists only leads / claims the caller may open.
  const picker = src("src/app/doc-editor/[id]/page.tsx");
  assert.match(picker, /getAccessibleLeadIds\(user\)\.then\(\(ids\) =>\s+prisma\.lead\.findMany\(\{\s+where: ids === null \? \{\} : \{ id: \{ in: ids \} \}/);
  assert.match(picker, /getAccessibleVehicleIds\(user\)\.then\(\(ids\) =>\s+prisma\.warrantyClaim\.findMany\(\{\s+where: ids === null \? \{\} : \{ vehicleId: \{ in: ids \} \}/);
});
