import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTACT_KINDS,
  capturesVatNumber,
  contactKind,
  contactKindColumns,
  parseContactKind,
  requiresFleet,
  type ContactKind,
} from "../src/lib/contactKind";
import { DEFAULT_FLEET_TYPE, FLEET_TYPES, parseFleetType } from "../src/lib/fleetTypes";
import { ruleFor } from "../src/lib/routeAccess";

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

// ── contactKind: the derive direction (existing row → selector) ──────────────
//
// This is the direction that silently breaks: a saved contact is re-rendered
// into the form, and if the mapping is re-derived slightly differently anywhere
// the edit screen shows the wrong type and saving it CHANGES the record.

test("an existing individual derives as individual", () => {
  assert.equal(contactKind({ isCompany: false, fleetId: null }), "individual");
});

test("an existing company with no fleet derives as business", () => {
  assert.equal(contactKind({ isCompany: true, fleetId: null }), "business");
});

test("an existing company linked to a fleet derives as fleet", () => {
  assert.equal(contactKind({ isCompany: true, fleetId: "flt_1" }), "fleet");
});

test("a fleet link wins over a missing company flag", () => {
  // Legacy/partial rows: membership is the stronger fact, and calling such a row
  // an individual would drop its fleet the moment somebody pressed Save.
  assert.equal(contactKind({ isCompany: false, fleetId: "flt_1" }), "fleet");
});

test("absent columns derive as individual, never as a company", () => {
  assert.equal(contactKind({}), "individual");
  assert.equal(contactKind({ isCompany: null, fleetId: null }), "individual");
});

// ── contactKindColumns: the write direction (selector → existing columns) ────

test("individual writes isCompany false and no fleet", () => {
  assert.deepEqual(contactKindColumns("individual", "flt_1"), { isCompany: false, fleetId: null });
});

test("business writes isCompany true and clears any fleet", () => {
  // Moving a contact off a fleet must actually drop the membership, or the fleet
  // page keeps listing somebody who is no longer part of it.
  assert.deepEqual(contactKindColumns("business", "flt_1"), { isCompany: true, fleetId: null });
});

test("fleet writes isCompany FALSE and keeps the chosen fleet", () => {
  // THE LOAD-BEARING ASSERTION OF THIS WHOLE FEATURE, and it reads backwards
  // until you know what `isCompany` does downstream.
  //
  // A fleet contact is a PERSON at a fleet account, not the account itself.
  // `contactName()` returns `company` INSTEAD of the person's name whenever
  // `isCompany && company` — a rule restated in the search SQL, the helpdesk SQL
  // and the portal-access SQL. A fleet member carries the fleet's name in
  // `company` (contactData copies it off the resolved Fleet), so flagging them as
  // a company would render every one of them as the FLEET's name: a fleet with
  // five contacts would list the same name five times, in the contacts list, in
  // search, in the inbox, everywhere. That is precisely the thing "a fleet may
  // have more than one contact" exists to make possible.
  //
  // The company-level facts live on the Fleet record instead, which is what
  // requirement 4 asked for, so the contact never needs to pretend to be one.
  assert.deepEqual(contactKindColumns("fleet", "flt_1"), { isCompany: false, fleetId: "flt_1" });
});

test("a fleet with no id is representable and maps to a plain individual", () => {
  // Deliberately total rather than throwing — the SERVER ACTION refuses this
  // input (see createContact/updateContact), so it can never be persisted, and
  // the helper stays pure.
  assert.deepEqual(contactKindColumns("fleet", null), { isCompany: false, fleetId: null });
  assert.equal(requiresFleet("fleet"), true);
  assert.equal(requiresFleet("business"), false);
  assert.equal(requiresFleet("individual"), false);
});

// ── round trip ───────────────────────────────────────────────────────────────

test("every kind survives a write-then-derive round trip", () => {
  const fleetId = "flt_round";
  for (const kind of CONTACT_KINDS) {
    assert.equal(contactKind(contactKindColumns(kind, fleetId)), kind, `${kind} must round trip`);
  }
});

// ── VAT visibility rides on the same helper ─────────────────────────────────

test("only a business contact carries a VAT number on the CONTACT record", () => {
  // Requirement 5 is "VAT is captured against the company". For a business
  // contact the contact IS the company. For a fleet contact the company is the
  // FLEET, so the number lives on Fleet.vatNumber and a second copy here would be
  // free to drift from it. An individual has no VAT number at all.
  assert.equal(capturesVatNumber("individual"), false);
  assert.equal(capturesVatNumber("business"), true);
  assert.equal(capturesVatNumber("fleet"), false);
});

// ── parseContactKind: what comes off the wire ───────────────────────────────

test("a submitted kind is accepted, anything else falls back to individual", () => {
  for (const kind of CONTACT_KINDS) assert.equal(parseContactKind(kind), kind);
  for (const bogus of ["", "company", "FLEET", null, undefined, 7, {}]) {
    assert.equal(parseContactKind(bogus), "individual" as ContactKind);
  }
});

// ── fleet types: one list, and it has a lodge in it ─────────────────────────

test("lodge is an offered fleet type", () => {
  assert.ok(FLEET_TYPES.includes("lodge"), "FLEET_TYPES must offer lodge");
  assert.ok(FLEET_TYPES.includes(DEFAULT_FLEET_TYPE), "the default must be one of the options");
});

test("a submitted fleet type is validated, not merely trimmed", () => {
  // `Fleet.type` is a free string column and createFleet/updateFleet are
  // POST-reachable without the <select> that offers the options, so an unchecked
  // value is stored verbatim and then rendered back on the list and the header.
  for (const type of FLEET_TYPES) assert.equal(parseFleetType(type), type);
  assert.equal(parseFleetType("lodge"), "lodge");
  // Not one we offer → "not set", never a silent substitution of the default:
  // recording an estate because someone sent nonsense is a lie about the record.
  for (const bogus of ["", "  ", "Lodge", "hotel", "<script>", null, undefined, 7, {}]) {
    assert.equal(parseFleetType(bogus), null, `${String(bogus)} must not be stored`);
  }
});

test("both fleet type selects render from the shared constant", () => {
  // The duplication this replaces is exactly why "lodge" could go missing: the
  // list lived in a page module and a second hardcoded default sat beside it.
  const list = read("src", "app", "(app)", "fleets", "page.tsx");
  const detail = read("src", "app", "(app)", "fleets", "[id]", "page.tsx");
  for (const [name, source] of [["fleets list", list], ["fleet detail", detail]] as const) {
    assert.match(source, /from "@\/lib\/fleetTypes"/, `${name} must import the shared constant`);
    assert.match(source, /FLEET_TYPES\.map\(/, `${name} must render its options from FLEET_TYPES`);
    assert.doesNotMatch(
      source,
      /\[\s*"estate"/,
      `${name} must not re-declare the type list inline`,
    );
    assert.doesNotMatch(
      source,
      /defaultValue="estate"/,
      `${name} must not hardcode the default type`,
    );
  }
  assert.doesNotMatch(list, /export const FLEET_TYPES/, "the list must not live in a page module");
});

// ── tenant safety on the queries this feature adds ──────────────────────────
//
// Enforcement is off in production, so the db.ts guard scopes NOTHING: a query
// without an explicit predicate reads every tenant's rows. These assert the
// predicate is present at the places a reviewer would otherwise have to
// re-check by hand.

test("every query the fleet pages issue directly names the tenant", () => {
  // The ROLL-UP's own queries are covered behaviourally in fleetRollup.test.ts —
  // run against a two-tenant fixture, which is the only thing that actually
  // proves isolation. This covers the queries that remain INLINE on the two
  // pages, which have no injected client and so cannot be run the same way.
  const detail = read("src", "app", "(app)", "fleets", "[id]", "page.tsx");
  assert.match(detail, /const tenant = activeTenantPredicate\(/);
  // Checked query by query rather than by counting: a page where three are
  // scoped and the fourth is not is exactly the failure this guards.
  const starts = [...detail.matchAll(/prisma\.\w+\.(findMany|findFirst)\(/g)];
  assert.ok(starts.length >= 3, `expected the page's own scoped queries, found ${starts.length}`);
  for (const start of starts) {
    const query = detail.slice(start.index, start.index + 320);
    assert.match(
      query,
      /\.\.\.tenant/,
      `unscoped query on the fleet page: ${query.split("\n").slice(0, 3).join(" ")}`,
    );
  }

  const list = read("src", "app", "(app)", "fleets", "page.tsx");
  assert.match(list, /activeTenantPredicate\(/);
});

test("a fleet chosen on the contact form is resolved inside the caller's tenant", () => {
  const contacts = read("src", "app", "actions", "contacts.ts");
  assert.match(contacts, /activeTenantPredicate\("contact fleet selection"\)/);
  assert.match(contacts, /prisma\.fleet\.findFirst/);
  // The refusal, not a silent downgrade to a plain business contact.
  assert.match(contacts, /Choose which fleet this contact belongs to/);
  // The company name comes from the resolved record, never from the request.
  assert.match(contacts, /company: fleet \? fleet\.name : str\("company"\)/);
});

test("every fleet mutation resolves the fleet inside the caller's tenant first", () => {
  const fleets = read("src", "app", "actions", "fleets.ts");
  assert.match(fleets, /async function tenantFleet/);
  assert.match(fleets, /activeTenantPredicate\("fleet mutation"\)/);
  for (const action of ["updateFleet", "updateFleetBusiness", "deleteFleet", "assignVehicleToFleet"]) {
    const body = fleets.slice(fleets.indexOf(`export async function ${action}(`));
    const end = body.indexOf("\nexport async function", 1);
    assert.match(
      end === -1 ? body : body.slice(0, end),
      /tenantFleet\(/,
      `${action} must resolve its fleet through tenantFleet`,
    );
  }
});

// ── guards on the new surfaces ──────────────────────────────────────────────

test("the fleet detail page is guarded exactly like its sibling route", () => {
  // Not requireUser() (no guard at all) and not requireOwner() (which would hide
  // a customer account from the staff who work it). requireRoute reads the SAME
  // ROUTE_RULES entry the edge proxy, the segment layout and the nav link use, so
  // the four cannot drift apart.
  const detail = read("src", "app", "(app)", "fleets", "[id]", "page.tsx");
  assert.match(detail, /requireRoute\("\/fleets"\)/, "the page must gate on the /fleets rule");
  assert.doesNotMatch(detail, /await requireUser\(\)/, "requireUser is not an authorization check");
  const rule = ruleFor("/fleets");
  assert.ok(rule && "anyOf" in rule, "/fleets must still be in ROUTE_RULES for requireRoute to mean anything");
  assert.deepEqual([...rule.anyOf], ["fleets.view", "fleets.manage"]);
});

test("no link on the fleet page is offered on a permission its destination ignores", () => {
  // The defect shape an open PR is fixing elsewhere in this app: a link rendered
  // on one permission, pointing somewhere guarded by another, whose only possible
  // outcome for the user who can see it is a bounce. Reaching this page needs
  // fleets.view; /contacts/new needs contacts.create.
  const detail = read("src", "app", "(app)", "fleets", "[id]", "page.tsx");
  assert.match(detail, /hasAnyPermission\(user, "contacts\.create"\)/);
  assert.match(
    detail,
    /canCreateContacts && \(\s*<Link href="\/contacts\/new"/,
    "the + Contact button must be gated on contacts.create",
  );
  const newContactPage = read("src", "app", "(app)", "contacts", "new", "page.tsx");
  assert.match(
    newContactPage,
    /requirePermission\("contacts\.create"\)/,
    "…which is the permission that page actually enforces",
  );
});

// ── the fleet record surfaces ───────────────────────────────────────────────

test("the fleet page carries the SAME tab set a contact does, plus its members", () => {
  // Requirement 6 in one assertion: "the fleets must have the same records as
  // contacts — if a contact is linked, all the details from those contacts show
  // up in here". The contact page's tabs are the reference list; Contacts is the
  // one a fleet has and a person does not.
  const detail = read("src", "app", "(app)", "fleets", "[id]", "page.tsx");
  for (const key of [
    "details",
    "contacts",
    "activities",
    "vehicles",
    "leads",
    "comms",
    "research",
    "referrals",
    "documents",
    "privacy",
  ]) {
    assert.match(detail, new RegExp(`key: "${key}"`), `the fleet page is missing the ${key} tab`);
  }
  // Populated from the roll-up, not stubbed out with a placeholder.
  assert.match(detail, /loadFleetRollup\(prisma, fleet\.id/, "the tabs must be fed by the roll-up");
  assert.match(detail, /updateFleetBusiness\.bind\(null, fleet\.id\)/);
  for (const field of ["registrationNumber", "vatNumber", "billingEmail", "billingPhone", "postalCode"]) {
    assert.match(detail, new RegExp(`name="${field}"`), `business details must capture ${field}`);
  }
  // Aggregated tabs must attribute rows, and must not offer a create form that
  // would file the new record against nothing.
  assert.match(detail, /contactLabel:/);
  assert.match(detail, /ownerLabel:/);
  assert.match(detail, /hideCreate/);
  assert.match(detail, /hideUpload/);
});

test("VAT is captured against both entities a quote can be addressed to", () => {
  const schema = read("prisma", "schema.prisma");
  const contact = /model Contact \{([\s\S]*?)^\}/m.exec(schema)?.[1] ?? "";
  const fleet = /model Fleet \{([\s\S]*?)^\}/m.exec(schema)?.[1] ?? "";
  assert.match(contact, /vatNumber\s+String\?/);
  assert.match(fleet, /vatNumber\s+String\?/);
  // Membership and primary contact are different columns on different models and
  // must both survive — collapsing them is the mistake this feature invites.
  assert.match(contact, /fleetId\s+String\?/);
  assert.match(fleet, /contactId\s+String\?/);
  // isCompany deliberately stays a boolean.
  assert.match(contact, /isCompany\s+Boolean\s+@default\(false\)/);
});

test("the fleet migration is additive and idempotent only", () => {
  const sql = read("prisma", "migrations", "20260805190000_fleet_business_record", "migration.sql");
  // Comments are stripped first: this file DOCUMENTS that it drops nothing and
  // makes nothing NOT NULL, and prose about a banned pattern is not the pattern.
  const statements = sql
    .split("\n")
    .filter((line) => line.trim() && !line.trim().startsWith("--"));
  assert.ok(statements.length > 0);
  for (const statement of statements) {
    assert.match(
      statement,
      /^(ALTER TABLE "\w+" ADD COLUMN IF NOT EXISTS|CREATE INDEX IF NOT EXISTS)/,
      `non-additive statement in the fleet migration: ${statement}`,
    );
  }
  assert.doesNotMatch(statements.join("\n"), /DROP |NOT NULL|CREATE TABLE/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "fleetId" TEXT/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS "Contact_fleetId_idx"/);
});
