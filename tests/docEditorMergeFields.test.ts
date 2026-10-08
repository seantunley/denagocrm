import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { VARIABLES } from "../src/lib/doceditor/variables";
import { COMPANY_DEFAULTS, companyTokens } from "../src/lib/companyBrand";
import { plateToHtmlBody } from "../src/lib/docbuilder/plateSerialize";
import { DEFAULT_REGIONAL as R } from "../src/lib/format";

/**
 * The doc-editor's "＋ variable" picker offers company, customer first name,
 * lead, staff member and today's date. Each one has to be FILLED by the
 * resolver, or picking it prints a placeholder on a customer's document.
 */

// merge.ts is server-only; the marker module is the only thing in the way of running it here.
type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const loader = Module as unknown as { _load: Loader };
const realLoad = loader._load;
loader._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return realLoad.call(this, request, parent, isMain);
} as Loader;
const merge = createRequire(import.meta.url)("../src/lib/docbuilder/merge.ts") as typeof import("../src/lib/docbuilder/merge");

const contact = {
  firstName: "Thandi", lastName: "Nkosi", phone: "082 000 0000", email: "thandi@example.invalid",
  address: null, suburb: null, city: null, province: null, postalCode: null, vatNumber: null,
};

function quote(over: Record<string, unknown> = {}) {
  return {
    number: 1042, createdAt: new Date("2026-09-01T10:00:00Z"), validUntil: null, status: "draft",
    taxInclusive: true, depositType: null, depositValue: null, fleetId: null,
    items: [], fees: [], contact,
    lead: { name: "Thandi Nkosi", title: "Rover XL enquiry", source: "website", valueCents: 23_500_000, product: { name: "Rover XL" }, phone: null, email: null },
    createdBy: { name: "Sean" },
    ...over,
  } as unknown as Parameters<typeof merge.buildQuoteContext>[0];
}

const jobCard = {
  number: 7, status: "in_progress", openedAt: new Date("2026-09-02T10:00:00Z"), completedAt: null, kmIn: null,
  description: "Annual service", notes: null, items: [],
  vehicle: { model: "Rover", vin: null, regNumber: null, color: null },
  contact: { ...contact, firstName: "Pieter", lastName: "Botha" },
  technician: null,
} as unknown as Parameters<typeof merge.buildJobCardContext>[0];

test("a quote fills customer.firstName and the lead fields", () => {
  const { tokens } = merge.buildQuoteContext(quote(), null, R);
  assert.equal(tokens["customer.firstName"], "Thandi");
  assert.equal(tokens["lead.name"], "Thandi Nkosi");
  assert.equal(tokens["lead.title"], "Rover XL enquiry");
  assert.equal(tokens["lead.source"], "website");
  assert.equal(tokens["lead.product"], "Rover XL");
  assert.match(tokens["lead.value"], /235/);
});

test("a customerless lead's quote still has a first name; a leadless quote has blank lead fields", () => {
  assert.equal(merge.buildQuoteContext(quote({ contact: null }), null, R).tokens["customer.firstName"], "Thandi");
  const { tokens } = merge.buildQuoteContext(quote({ lead: null }), null, R);
  for (const key of ["lead.name", "lead.title", "lead.source", "lead.product", "lead.value"]) {
    assert.equal(tokens[key], "", `${key} is blank, not "undefined"`);
  }
});

test("a job card fills customer.firstName", () => {
  assert.equal(merge.buildJobCardContext(jobCard, null, R).tokens["customer.firstName"], "Pieter");
});

test("user.name and date.today are filled for every document", () => {
  const globals = merge.documentGlobalTokens("  Sean Tunley ", new Date("2026-09-29T09:00:00Z"));
  assert.equal(globals["user.name"], "Sean Tunley");
  assert.match(globals["date.today"], /2026/);
  // No staff member (a customer's signing page): blank, never "undefined".
  assert.equal(merge.documentGlobalTokens(null)["user.name"], "");
});

test("every variable the picker offers is filled by some resolver", () => {
  const filled = new Set([
    ...Object.keys(merge.buildQuoteContext(quote(), null, R).tokens),
    ...Object.keys(merge.buildJobCardContext(jobCard, null, R).tokens),
    ...Object.keys(companyTokens(COMPANY_DEFAULTS)),
    ...Object.keys(merge.documentGlobalTokens("x")),
  ]);
  const offered = VARIABLES.flatMap((group) => group.fields);
  const unfilled = offered.filter((key) => !filled.has(key));
  assert.deepEqual(unfilled, [], `the picker offers variables nothing resolves: ${unfilled.join(", ")}`);
  for (const key of ["company.name", "company.address", "company.phone", "company.email", "customer.firstName", "lead.title", "lead.source", "user.name", "date.today"]) {
    assert.ok(offered.includes(key), `${key} is in the picker`);
  }
});

test("a variable the record cannot fill keeps the existing unresolved style", () => {
  // lead.* on a job card: the same pill any unfilled variable renders as.
  const ctx = merge.buildJobCardContext(jobCard, null, R);
  const html = plateToHtmlBody([{ type: "p", children: [{ type: "mergeField", token: "lead.title", children: [{ text: "" }] }] }], ctx);
  assert.match(html, /background:#fff7ed/);
  assert.match(html, /Lead title/);
});
