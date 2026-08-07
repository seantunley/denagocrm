import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { quoteBillTo, loadBillToFleets, type BillToFleet } from "../src/lib/quoteBillTo";
import { withTenant } from "../src/lib/tenantScope";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * A quote can now be addressed to a FLEET ACCOUNT rather than to a person, and
 * the thing that decides which is one function — because before this there were
 * nine copies of "who is this for", and adding a third possibility to nine
 * copies is how eight of them get it right.
 */

const LODGE: BillToFleet = {
  id: "flt_1",
  name: "Kloof Lodge",
  registrationNumber: "2019/123456/07",
  vatNumber: "4123456789",
  billingEmail: "accounts@klooflodge.co.za",
  billingPhone: "021 555 0100",
  address: "12 Valley Road",
  suburb: "Hout Bay",
  city: "Cape Town",
  province: "Western Cape",
  postalCode: "7806",
};

const MANAGER = {
  firstName: "Thandi",
  lastName: "Mokoena",
  isCompany: false,
  company: "Kloof Lodge",
  phone: "082 555 0199",
  email: "thandi@klooflodge.co.za",
  vatNumber: "9999999999",
  address: "7 Personal Street",
  suburb: "Newlands",
  city: "Cape Town",
  province: "Western Cape",
  postalCode: "7700",
};

test("a fleet quote is addressed to the BUSINESS, with the person as attention", async () => {
  const billTo = quoteBillTo({ fleetId: LODGE.id, contact: MANAGER, lead: null }, LODGE);
  assert.equal(billTo.name, "Kloof Lodge", "the invoice goes to the account");
  assert.equal(billTo.attention, "Thandi Mokoena", "the conversation goes to the manager");
  assert.equal(billTo.isFleet, true);
  // The account's own billing details, not the manager's personal ones — that is
  // what those columns on Fleet are for.
  assert.equal(billTo.email, "accounts@klooflodge.co.za");
  assert.equal(billTo.phone, "021 555 0100");
  assert.equal(billTo.address, "12 Valley Road, Hout Bay, Cape Town, Western Cape, 7806");
  assert.equal(billTo.registrationNumber, "2019/123456/07");
});

test("a fleet quote NEVER borrows the contact's VAT number", async () => {
  // The sharpest one. A fleet member's personal VAT registration is not the
  // account's, and a wrong VAT number on an invoice is a tax document that
  // misstates who may claim the input credit. Empty is correct; the manager's is
  // not.
  const noVat: BillToFleet = { ...LODGE, vatNumber: null };
  const billTo = quoteBillTo({ fleetId: LODGE.id, contact: MANAGER, lead: null }, noVat);
  assert.equal(billTo.vatNumber, "", "an account with no VAT number prints none");
  assert.notEqual(billTo.vatNumber, MANAGER.vatNumber);
});

test("the fleet falls back to the person for CONTACT details, but never for identity", async () => {
  // A fleet with no billing contact captured yet must still produce a reachable
  // quote — but the party it is addressed to does not change.
  const bare: BillToFleet = { ...LODGE, billingEmail: null, billingPhone: null };
  const billTo = quoteBillTo({ fleetId: LODGE.id, contact: MANAGER, lead: null }, bare);
  assert.equal(billTo.name, "Kloof Lodge");
  assert.equal(billTo.email, MANAGER.email);
  assert.equal(billTo.phone, MANAGER.phone);
});

test("an unresolved fleet id prints the contact — it does not print a guess", async () => {
  // This is what a cross-tenant id does: loadBillToFleets returns nothing for it,
  // so the caller passes null, and the quote reads exactly as it did before
  // fleets could be billed. Never a blank name, never another workspace's.
  const billTo = quoteBillTo({ fleetId: "flt_from_another_tenant", contact: MANAGER, lead: null }, null);
  assert.equal(billTo.name, "Thandi Mokoena");
  assert.equal(billTo.attention, null, "there is no business to be 'attention of'");
  assert.equal(billTo.isFleet, false);
  assert.equal(billTo.vatNumber, MANAGER.vatNumber, "a person's own quote carries their own VAT number");
});

test("precedence is fleet → contact → lead, and an unlinked quote still has a name", async () => {
  const lead = { name: "Walk-in — golf estate", phone: "083 555 0000", email: "walkin@example.com" };
  assert.equal(quoteBillTo({ contact: MANAGER, lead }, LODGE).name, "Kloof Lodge");
  assert.equal(quoteBillTo({ contact: MANAGER, lead }, null).name, "Thandi Mokoena");
  const fromLead = quoteBillTo({ contact: null, lead }, null);
  assert.equal(fromLead.name, "Walk-in — golf estate");
  assert.equal(fromLead.phone, "083 555 0000");
  assert.deepEqual(quoteBillTo({}, null), {
    name: "",
    attention: null,
    phone: "",
    email: "",
    address: "",
    vatNumber: "",
    registrationNumber: "",
    isFleet: false,
  });
});

test("a company CONTACT still prints as the company, with no attention line", async () => {
  // contactName() already returns the company instead of the person when
  // isCompany && company. That rule is untouched — a business contact is not a
  // fleet account and has no separate person to be 'attention of'.
  const company = { ...MANAGER, isCompany: true, company: "Sandton Golf Carts (Pty) Ltd" };
  const billTo = quoteBillTo({ contact: company, lead: null }, null);
  assert.equal(billTo.name, "Sandton Golf Carts (Pty) Ltd");
  assert.equal(billTo.attention, null);
});

/* ── the tenant boundary ─────────────────────────────────────────────────── */

type FleetRow = BillToFleet & { tenantId: string | null; deletedAt: Date | null };

/** Minimal stand-in for the one delegate loadBillToFleets uses. */
function fleetClient(rows: FleetRow[]) {
  const wheres: Array<Record<string, unknown>> = [];
  return {
    wheres,
    client: {
      fleet: {
        findMany(args: { where: Record<string, unknown> }) {
          wheres.push(args.where);
          const where = args.where as {
            id: { in: string[] };
            deletedAt: null;
            tenantId?: string | null;
          };
          return Promise.resolve(
            rows.filter(
              (row) =>
                where.id.in.includes(row.id) &&
                row.deletedAt === null &&
                (!("tenantId" in where) || row.tenantId === where.tenantId),
            ),
          );
        },
      },
    },
  };
}

const MINE = "tenant_mine";
const THEIRS = "tenant_theirs";

test("a fleet id belonging to another tenant does not resolve", async () => {
  // Quote.fleetId carries NO foreign key — deliberately, matching Contact.fleetId
  // — so nothing in the database stops a colliding or forged id being written.
  // This predicate is what stops it being READ back onto a customer-facing
  // document as another operator's account name, registration and VAT numbers.
  const { client, wheres } = fleetClient([
    { ...LODGE, id: "flt_shared", tenantId: THEIRS, deletedAt: null },
  ]);
  const resolved = await withTenant(MINE, () => loadBillToFleets(client, ["flt_shared"]));
  assert.equal(resolved.size, 0, "the other tenant's fleet must not resolve");
  assert.equal(wheres[0].tenantId, MINE, "the query must name the tenant, not filter afterwards");
});

test("a deleted fleet does not resolve either", async () => {
  const { client } = fleetClient([
    { ...LODGE, tenantId: MINE, deletedAt: new Date("2026-01-01") },
  ]);
  const resolved = await withTenant(MINE, () => loadBillToFleets(client, [LODGE.id]));
  assert.equal(resolved.size, 0, "a trashed account is not an account to bill");
});

test("no fleet ids means no query at all", async () => {
  const { client, wheres } = fleetClient([{ ...LODGE, tenantId: MINE, deletedAt: null }]);
  const resolved = await withTenant(MINE, () => loadBillToFleets(client, [null, undefined, ""]));
  assert.equal(resolved.size, 0);
  assert.equal(wheres.length, 0, "a page of quotes with no fleet must cost nothing");
});

test("the batch is deduplicated — one query, one row per account", async () => {
  const { client, wheres } = fleetClient([{ ...LODGE, tenantId: MINE, deletedAt: null }]);
  const resolved = await withTenant(MINE, () =>
    loadBillToFleets(client, [LODGE.id, LODGE.id, LODGE.id, null]),
  );
  assert.equal(wheres.length, 1, "the list renders 200 rows; this must not be 200 round trips");
  assert.deepEqual((wheres[0].id as { in: string[] }).in, [LODGE.id]);
  assert.equal(resolved.get(LODGE.id)?.name, "Kloof Lodge");
});

/* ── one resolver, every renderer ────────────────────────────────────────── */

/**
 * Every file that prints who a quote is for. Discovered by rule rather than
 * listed, because a hand-written list is what let nine copies of this exist.
 */
function quoteRenderers(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name)) {
        const code = shipped(rel);
        // A file that reads a quote's customer, by the shape all nine copies had.
        if (/quote\.contact\b|quote\.lead\?\.name/.test(code)) out.push(rel);
      }
    }
  };
  walk("src");
  return out;
}

/**
 * The one place that legitimately still names the PERSON.
 *
 * `contactLabel` on the editor record means "the contact", not "the customer" —
 * the editor shows the account separately as `fleetLabel` and prints them as
 * "Kloof Lodge · attn Thandi Mokoena". Resolving it through quoteBillTo would
 * make both halves say the same thing.
 */
const NAMES_THE_PERSON_ON_PURPOSE = ["src/lib/quoteEditorRecord.ts"];

test("nothing computes a quote's customer for itself any more", () => {
  const offenders = quoteRenderers().filter((rel) => {
    if (NAMES_THE_PERSON_ON_PURPOSE.includes(rel)) return false;
    const code = shipped(rel);
    // The copied shape: pick the contact's name, else the lead's.
    return /quote\.contact \? contactName\(quote\.contact\)/.test(code);
  });
  assert.deepEqual(
    offenders,
    [],
    `these still decide the addressee themselves and will print the manager where the fleet belongs: ${offenders.join(", ")}`,
  );
});

test("every document that states a customer resolves the fleet first", () => {
  // The four that are handed to the customer. Each must LOOK UP the fleet — a
  // renderer that only calls quoteBillTo(quote, null) is a renderer that can
  // never show a fleet.
  for (const rel of [
    "src/lib/docbuilder/merge.ts",
    "src/lib/pdf/QuoteDoc.tsx",
    "src/components/print/QuotePrintDoc.tsx",
    "src/app/(print)/quotes/[id]/invoice/page.tsx",
    "src/app/(print)/quotes/[id]/agreement/page.tsx",
    "src/app/(print)/quotes/[id]/delivery-note/page.tsx",
  ]) {
    assert.match(shipped(rel), /quoteBillTo\(/, `${rel} must resolve the addressee through the shared function`);
  }
  for (const rel of [
    "src/lib/signing/render.ts",
    "src/lib/doceditor/generate.ts",
    "src/app/api/pdf/quote/[id]/route.tsx",
    "src/app/(print)/quotes/[id]/invoice/page.tsx",
    "src/app/(print)/quotes/[id]/agreement/page.tsx",
    "src/app/(print)/quotes/[id]/delivery-note/page.tsx",
  ]) {
    assert.match(
      shipped(rel),
      /loadBillToFleet\(/,
      `${rel} must resolve the fleet through the tenant-scoped loader`,
    );
  }
});

test("the fleet is a required parameter, not an optional one a caller can forget", () => {
  // An optional `fleet?: …` would compile at every existing call site and print
  // the wrong customer at all of them. The compiler is the enforcement here; this
  // asserts the compiler was given something to enforce.
  assert.match(
    shipped("src/lib/docbuilder/merge.ts"),
    /buildQuoteContext\(quote: QuoteForPrint, fleet: BillToFleet \| null\)/,
  );
  assert.match(shipped("src/lib/pdf/QuoteDoc.tsx"), /fleet: BillToFleet \| null;/);
  assert.match(shipped("src/components/print/QuotePrintDoc.tsx"), /fleet: BillToFleet \| null;/);
});

/* ── creating one ────────────────────────────────────────────────────────── */

test("a fleet quote can only be raised for a person who belongs to that fleet", () => {
  const code = shipped("src/app/actions/quotes.ts");
  const start = code.indexOf("export async function createQuoteForFleet(");
  assert.notEqual(start, -1, "createQuoteForFleet is gone — was it renamed?");
  const body = code.slice(start, code.indexOf("export async function saveQuoteDraft(", start));

  // The permission gate precedes every refusal: a refusal is a reply, and
  // replying to an unauthorised caller confirms the endpoint responds.
  const gate = body.indexOf('await requirePermission("quotes.create")');
  const firstRefusal = body.indexOf("throw new ActionRefusal");
  assert.ok(gate !== -1 && gate < firstRefusal, "authorise before refusing");

  assert.match(
    body,
    /activeTenantPredicate\("quote for fleet"\)/,
    "the fleet must be resolved inside the caller's tenant — there is no foreign key to catch it",
  );
  assert.match(
    body,
    /contact\.fleetId !== fleet\.id && fleet\.contactId !== contact\.id/,
    "manager OR member — a quote naming a fleet beside an unrelated person is a wrong tax document",
  );
  assert.match(body, /await requireContactAccess\(contactId, "quotes\.create"\)/);
});

test("the customer on a fleet quote cannot be swapped afterwards", () => {
  // Otherwise the membership check above is a formality: raise the quote with a
  // valid member, then edit the contact to anyone at all.
  const code = shipped("src/app/actions/quotes.ts");
  assert.match(
    code,
    /if \(existing\.fleetId && existing\.contactId !== data\.contactId\)/,
    "a fleet quote's customer must be as fixed as a lead-linked quote's",
  );
});

test("saveQuoteDraft cannot set or clear the fleet at all", () => {
  // The binding is creation-time, like leadId. If the draft schema ever accepts
  // it, the membership and tenant checks in createQuoteForFleet stop being the
  // only way a quote acquires an account.
  const code = shipped("src/app/actions/quotes.ts");
  const start = code.indexOf("const quoteDraftSchema = z.object({");
  const schema = code.slice(start, code.indexOf("});", start));
  assert.doesNotMatch(schema, /fleetId/, "the editor must not be able to rebind the account");
});
