import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildXeroContact,
  buildXeroInvoice,
  chooseXeroOrganisation,
  feeKindForXero,
  parseXeroItemLink,
  sellableXeroItems,
  liveInvoiceWithReference,
  matchXeroContact,
  pickTaxType,
  parseXeroTaxChoices,
  withXeroTaxChoice,
  xeroTaxRateChoices,
  quoteTaxRates,
  readXeroInvoice,
  totalsDiffer,
  xeroErrorMessage,
  xeroLockReason,
  XERO_STALE_SEND_MS,
  XERO_UNCONFIRMED,
  xeroSendPlan,
  xeroStatusAfterFailedSend,
  xeroPdfFileName,
  xeroReference,
  legacyXeroReference,
  xeroStatusLabel,
  type XeroQuoteInput,
} from "../src/lib/xeroInvoice";
import { quotePricing } from "../src/lib/pricing";
import { TENANT_CREDENTIAL_INTEGRATIONS } from "../src/lib/tenantCredentialFields";
import { isSecretSettingKey } from "../src/lib/settings";
import { SYSTEM_DOCUMENT_TAGS, SYSTEM_TAG_LABELS } from "../src/lib/documentLabels";

const quote = (over: Partial<XeroQuoteInput> = {}): XeroQuoteInput => ({
  id: "cq1029abc",
  number: 1029,
  invoiceNumber: 123,
  taxInclusive: true,
  currency: null,
  invoicedAt: new Date("2026-11-10T22:30:00Z"), // 11 Nov in Johannesburg
  items: [
    { description: "Denago Rover XL", qty: 1, unitPriceCents: 24_000_000, discountPct: 5, taxRatePct: 15 },
    { description: "Roof", qty: 1, unitPriceCents: 450_000, optional: true, selected: false, taxRatePct: 15 },
    { description: "Trade-in", qty: 1, unitPriceCents: -5_000_000, taxRatePct: 15 },
  ],
  fees: [{ label: "Cape Town", kind: "delivery", amountCents: 550_000, taxRatePct: 15 }],
  ...over,
});
const opts = { contactId: "c-1", salesAccount: "", taxTypes: { "15": "OUTPUT", "0": "ZERORATEDOUTPUT" } };

// ── Matching the CRM invoice ───────────────────────────────────────────────

test("a DRAFT sales invoice, for the Xero contact by ID, with our numbers in the Reference", () => {
  const x = buildXeroInvoice(quote(), opts);
  assert.equal(x.Type, "ACCREC");
  assert.equal(x.Status, "DRAFT");
  assert.deepEqual(x.Contact, { ContactID: "c-1" });
  // Sean, 2026-11-11: just our invoice and quote numbers — no long code.
  assert.equal(x.Reference, "INV-000123 / Q-1029");
  assert.equal(xeroReference({ number: 1029, invoiceNumber: null }), "Q-1029");
  assert.equal(x.Date, "2026-11-11");
  assert.equal(x.LineAmountTypes, "Inclusive");
  assert.equal(x.CurrencyCode, undefined);
  // Unique because one Xero organisation is connected to ONE workspace — enforced at connect, under a lock on the organisation.
  const lib = readFileSync("src/lib/xero.ts", "utf8");
  const exchange = lib.slice(lib.indexOf("export async function exchangeXeroCode("), lib.indexOf("async function forgetXeroLinks("));
  const steps = [
    "pg_advisory_xact_lock(hashtext(${`xero-org:${org.tenantId}`}))",
    "if (await xeroOrganisationTakenElsewhere(tx, input.tenantId, org.tenantId)) {",
    "throw new XeroOrganisationInUse(",
    "await putTenantCredentialBundle(",
  ].map((s) => exchange.indexOf(s));
  assert.ok(steps.every((at, i) => at > 0 && (i === 0 || at > steps[i - 1])), `lock the organisation, refuse if another workspace has it, then save: ${steps}`);
  assert.match(readFileSync("src/app/api/integrations/xero/callback/route.ts", "utf8"), /if \(err instanceof XeroOrganisationInUse\) return back\("in-use"\);/);
  // Every place a connection can live — credential rows AND the settings store (the founding workspace's fallback).
  const taken = lib.slice(lib.indexOf("export async function xeroOrganisationTakenElsewhere("));
  assert.match(taken, /tx\.tenantIntegrationCredential\.count\(\{ where: \{ tenantId: \{ not: tenantId \}, key: "XERO_TENANT_ID", value: xeroOrgId \} \}\)/);
  assert.match(taken, /tx\.appSetting\.count\(\{ where: \{ tenantId: \{ not: tenantId \}, key: "XERO_TENANT_ID", value: xeroOrgId \} \}\)/);
});

test("an invoice made under the OLD long Reference and never confirmed is still found on retry — never made twice", () => {
  // Review of #1069: sends before 2026-11-11 wrote "INV-… / Q-… / <quote id>". One whose reply was lost
  // (UNCONFIRMED) must be found by the retry, which now writes the short Reference.
  const q = { id: "cmvpkw3xv0001ig089nfn2vao", number: 1037, invoiceNumber: 43155 };
  assert.equal(xeroReference(q), "INV-043155 / Q-1037", "new invoices: short");
  assert.equal(legacyXeroReference(q), "INV-043155 / Q-1037 / cmvpkw3xv0001ig089nfn2vao", "exactly what the old sends wrote");
  const xeroHasOld = { Invoices: [{ Type: "ACCREC", InvoiceID: "made-before", InvoiceNumber: "INV-0007", Reference: legacyXeroReference(q), Status: "DRAFT", Total: 100 }] };
  assert.equal(liveInvoiceWithReference(xeroHasOld, xeroReference(q)), null, "the short search alone would miss it");
  assert.equal(liveInvoiceWithReference(xeroHasOld, legacyXeroReference(q))?.id, "made-before", "the old-format search finds it");
  const actions = readFileSync("src/app/actions/xero.ts", "utf8");
  assert.match(actions, /\(await client\.findInvoiceByReference\(reference\)\) \?\? \(await client\.findInvoiceByReference\(legacyXeroReference\(quote\)\)\)/);
  assert.ok(actions.indexOf("legacyXeroReference(quote)") < actions.indexOf("client.createInvoice("), "both searched before anything is created");
  assert.doesNotMatch(readFileSync("src/lib/xeroInvoice.ts", "utf8"), /Reference: legacyXeroReference/, "the old format is never written");
});

test("the lines are the CRM invoice's rows, each with its tax type and the CRM's own VAT amount", () => {
  const x = buildXeroInvoice(quote(), { ...opts, salesAccount: "4000" });
  assert.deepEqual(x.LineItems, [
    // R240 000 less 5% = R228 000 incl. → VAT 228000 − 228000/1.15 = 29 739.13
    { Description: "Denago Rover XL", Quantity: 1, UnitAmount: 240000, AccountCode: "4000", TaxType: "OUTPUT", TaxAmount: 29739.13, DiscountRate: 5 },
    { Description: "Trade-in", Quantity: 1, UnitAmount: -50000, AccountCode: "4000", TaxType: "OUTPUT", TaxAmount: -6521.74 },
    { Description: "Delivery — Cape Town", Quantity: 1, UnitAmount: 5500, AccountCode: "4000", TaxType: "OUTPUT", TaxAmount: 717.39 },
  ]);
});

test("Xero's VAT adds up to exactly the CRM's VAT", () => {
  for (const taxInclusive of [true, false]) {
    const q = quote({ taxInclusive });
    const x = buildXeroInvoice(q, opts);
    const xeroVatCents = Math.round(x.LineItems.reduce((sum, line) => sum + line.TaxAmount, 0) * 100);
    const crm = quotePricing(q.items, q.fees, { taxInclusive });
    assert.equal(xeroVatCents, crm.taxCents, taxInclusive ? "inclusive" : "exclusive");
  }
});

test("a rate with no Xero tax type stops the send rather than guess", () => {
  assert.throws(() => buildXeroInvoice(quote({ fees: [{ label: "Export docs", amountCents: 1000, taxRatePct: 7 }] }), opts), /No Xero tax type for 7%/);
  assert.deepEqual(quoteTaxRates(quote({ fees: [{ label: "x", amountCents: 1, taxRatePct: 0 }] })).sort(), [0, 15]);
});

test("tax types: exact active revenue rate; 0% prefers zero-rated; ambiguous or missing refuses", () => {
  const rates = [
    { Name: "Standard Rate Sales", TaxType: "OUTPUT", Status: "ACTIVE", EffectiveRate: 15, CanApplyToRevenue: true },
    { Name: "Standard Rate Purchases", TaxType: "INPUT", Status: "ACTIVE", EffectiveRate: 15, CanApplyToRevenue: false },
    { Name: "Old 14%", TaxType: "OUTPUT14", Status: "DELETED", EffectiveRate: 14, CanApplyToRevenue: true },
    { Name: "Zero Rated Sales", TaxType: "ZERORATEDOUTPUT", Status: "ACTIVE", EffectiveRate: 0, CanApplyToRevenue: true },
    { Name: "Exempt and Non-Supplies", TaxType: "EXEMPTOUTPUT", Status: "ACTIVE", EffectiveRate: 0, CanApplyToRevenue: true },
  ];
  assert.deepEqual(pickTaxType(rates, 15), { ok: true, taxType: "OUTPUT" });
  assert.deepEqual(pickTaxType(rates, 0), { ok: true, taxType: "ZERORATEDOUTPUT" });
  assert.equal(pickTaxType(rates, 14).ok, false, "a deleted rate is never used");
  const twoStandard = [...rates, { Name: "Standard Rate Sales (Capital)", TaxType: "OUTPUTCAP", Status: "ACTIVE", EffectiveRate: 15, CanApplyToRevenue: true }];
  const ambiguous = pickTaxType(twoStandard, 15);
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.ok ? "" : ambiguous.error, /several sales tax rates at 15%.*Settings → Integrations → Xero → Sales tax/);
  // The workspace's choice settles it — while Xero still has that rate live at that %.
  const cap = { taxType: "OUTPUTCAP", name: "Standard Rate Sales - Capital Goods" };
  assert.deepEqual(pickTaxType(twoStandard, 15, cap), { ok: true, taxType: "OUTPUTCAP" });
  assert.deepEqual(pickTaxType(twoStandard, 15, { taxType: "OUTPUT", name: "Standard Rate Sales" }), { ok: true, taxType: "OUTPUT" });
  assert.equal(pickTaxType(twoStandard, 15, { taxType: "INPUT", name: "Purchases" }).ok, false, "a purchases rate is never accepted as the choice");
  assert.equal(pickTaxType(twoStandard, 15, { taxType: "OUTPUT14", name: "Old" }).ok, false, "nor a deleted / other-% one");
  // Review of #1068: the chosen rate is deactivated in Xero and ONE 15% rate is left —
  // refuse and ask, never quietly switch capital goods to the standard rate.
  const capDeactivated = twoStandard.map((r) => (r.TaxType === "OUTPUTCAP" ? { ...r, Status: "ARCHIVED" } : r));
  assert.deepEqual(pickTaxType(capDeactivated, 15), { ok: true, taxType: "OUTPUT" }, "with no choice, the one left is fine");
  const refused = pickTaxType(capDeactivated, 15, cap);
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /"Standard Rate Sales - Capital Goods"\) is no longer a live sales rate in Xero\. Choose again/);
});

test("Xero settings are always read and written for a NAMED workspace, never the general settings", () => {
  // getSetting/putSetting fall back to the founding workspace while enforcement is
  // off — one workspace's Xero choice reached another that way (review of #1068).
  for (const path of ["src/app/actions/xero.ts", "src/lib/xero.ts", "src/app/(app)/settings/integrations/page.tsx"]) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /\b(getSetting|putSetting)\(/, `${path} uses the general settings`);
  }
  const actions = readFileSync("src/app/actions/xero.ts", "utf8");
  for (const use of [
    "getWorkspaceSetting(tenantId, XERO_TAX_CHOICES_KEY)",
    "putWorkspaceSetting(tenantId, XERO_TAX_CHOICES_KEY,",
    "getWorkspaceSetting(tenantId, XERO_FEE_ITEM_KEYS.delivery)",
    "putWorkspaceSetting(tenantId, XERO_FEE_ITEM_KEYS[kind],",
  ]) assert.ok(actions.includes(use), use);
});

test("Settings' sales tax choice: only percentages with more than one live sales rate are offered", () => {
  // South Africa, 2026-11-11: six sales rates at 15%.
  const za = [
    { Name: "Standard Rate Sales", TaxType: "OUTPUT", Status: "ACTIVE", EffectiveRate: 15, CanApplyToRevenue: true },
    { Name: "Standard Rate Sales - Capital Goods", TaxType: "OUTPUTCAP", Status: "ACTIVE", EffectiveRate: 15, CanApplyToRevenue: true },
    { Name: "Accommodation under 28 days", TaxType: "ACC28", Status: "ACTIVE", EffectiveRate: 15, CanApplyToRevenue: true },
    { Name: "Standard Rate Purchases", TaxType: "INPUT", Status: "ACTIVE", EffectiveRate: 15, CanApplyToRevenue: false },
    { Name: "Zero Rated Sales", TaxType: "ZERORATEDOUTPUT", Status: "ACTIVE", EffectiveRate: 0, CanApplyToRevenue: true },
  ];
  assert.deepEqual(xeroTaxRateChoices(za), [
    { pct: 15, options: [
      { taxType: "OUTPUT", name: "Standard Rate Sales" },
      { taxType: "OUTPUTCAP", name: "Standard Rate Sales - Capital Goods" },
      { taxType: "ACC28", name: "Accommodation under 28 days" },
    ] },
  ]);
  // Review of #1068: the chosen rate is deactivated and ONE live 15% rate is left. The
  // saved % is still offered (with that one rate), so the owner can change or clear it.
  const oneLeft = za.filter((r) => r.TaxType !== "OUTPUTCAP" && r.TaxType !== "ACC28");
  assert.deepEqual(xeroTaxRateChoices(oneLeft), [], "nothing to choose without a saved choice");
  assert.deepEqual(xeroTaxRateChoices(oneLeft, [15]), [{ pct: 15, options: [{ taxType: "OUTPUT", name: "Standard Rate Sales" }] }]);
  assert.deepEqual(xeroTaxRateChoices([], [15]), [{ pct: 15, options: [] }], "even with no live rate left, it can be cleared");
  // Review of #1068: a choice is actually STORED — save it, read it back, the send uses it.
  const standard = { taxType: "OUTPUT", name: "Standard Rate Sales" };
  const savedOnce = parseXeroTaxChoices(withXeroTaxChoice({}, 15, standard));
  assert.deepEqual(savedOnce, { "15": standard }, "what is saved is what is read back");
  const sixAt15 = [...za, { Name: "Change in use Sales", TaxType: "CHANGEUSE", Status: "ACTIVE", EffectiveRate: 15, CanApplyToRevenue: true }];
  assert.equal(pickTaxType(sixAt15, 15).ok, false, "before the choice: refused as ambiguous");
  assert.deepEqual(pickTaxType(sixAt15, 15, savedOnce["15"]), { ok: true, taxType: "OUTPUT" }, "after it: the chosen rate");
  // Changing one % keeps the others; clearing removes only that one.
  const two = parseXeroTaxChoices(withXeroTaxChoice(savedOnce, 0, { taxType: "ZERORATEDOUTPUT", name: "Zero Rated Sales" }));
  assert.deepEqual(Object.keys(two).sort(), ["0", "15"]);
  assert.deepEqual(parseXeroTaxChoices(withXeroTaxChoice(two, 15, null)), { "0": { taxType: "ZERORATEDOUTPUT", name: "Zero Rated Sales" } });
  const actions = readFileSync("src/app/actions/xero.ts", "utf8");
  // The action writes ONLY what withXeroTaxChoice builds — never the map it read.
  assert.match(actions, /putWorkspaceSetting\(tenantId, XERO_TAX_CHOICES_KEY, withXeroTaxChoice\(choices, pct, option\)\)/, "a choice is saved");
  assert.match(actions, /putWorkspaceSetting\(tenantId, XERO_TAX_CHOICES_KEY, withXeroTaxChoice\(choices, pct, null\)\)/, "an empty choice clears it");
  assert.doesNotMatch(actions, /putWorkspaceSetting\(tenantId, XERO_TAX_CHOICES_KEY, JSON\.stringify\(choices\)\)/);
  assert.match(actions, /xeroTaxRateChoices\(await \(await xeroClient\(tenantId\)\)\.listTaxRates\(\), saved\)/, "the list offers saved percentages");
  assert.match(readFileSync("src/components/XeroTaxRatePicker.tsx", "utf8"), /<option value="" disabled=\{!saved\}>\{saved \? "— Clear the choice —"/);
  assert.deepEqual(parseXeroTaxChoices('{"15":{"taxType":"OUTPUT","name":"Standard Rate Sales"}}'), { "15": { taxType: "OUTPUT", name: "Standard Rate Sales" } });
  assert.deepEqual(parseXeroTaxChoices(""), {});
  assert.deepEqual(parseXeroTaxChoices('{"15":{"name":"no type"}}'), {});
  // Wired: the send uses the choice; an organisation switch forgets it with the other Xero codes.
  assert.match(readFileSync("src/app/actions/xero.ts", "utf8"), /client\.taxTypes\(quoteTaxRates\(quote\), parseXeroTaxChoices\(await getWorkspaceSetting\(tenantId, XERO_TAX_CHOICES_KEY\)\)\)/);
  assert.match(readFileSync("src/lib/xero.ts", "utf8"), /key: \{ in: \[\.\.\.Object\.values\(XERO_FEE_ITEM_KEYS\), XERO_TAX_CHOICES_KEY\] \}/);
});

// ── Item codes ──────────────────────────────────────────────────────────────

test("a linked product line carries its Xero item code and the item's account; wording, price and VAT stay the CRM's", () => {
  const q = quote({
    items: [{ description: "Denago Rover XL", qty: 1, unitPriceCents: 24_000_000, taxRatePct: 15, xeroItemCode: "RXL", xeroAccountCode: "4010" }],
    fees: [
      { label: "Cape Town", kind: "delivery", amountCents: 550_000, taxRatePct: 15, xeroItemCode: "DEL", xeroAccountCode: null },
      { label: "Licensing", kind: "fee", amountCents: 120_000, taxRatePct: 15 },
    ],
  });
  const [model, delivery, other] = buildXeroInvoice(q, { ...opts, salesAccount: "4000" }).LineItems;
  assert.equal(model.ItemCode, "RXL");
  assert.equal(model.AccountCode, "4010");
  assert.equal(model.Description, "Denago Rover XL");
  assert.equal(model.UnitAmount, 240000);
  assert.equal(delivery.ItemCode, "DEL");
  assert.equal(delivery.AccountCode, "4000", "an item with no sales account falls back to the workspace's");
  assert.equal(delivery.Description, "Delivery — Cape Town");
  assert.equal(other.ItemCode, undefined, "an unlinked fee goes without a code");
});

test("Xero items: only sold ones, sorted; fee settings and kinds", () => {
  assert.deepEqual(
    sellableXeroItems([
      { ItemID: "2", Code: "RXL", Name: "Rover XL", SalesDetails: { AccountCode: "4010" } },
      { ItemID: "1", Code: "DEL", Name: "Delivery", IsSold: true },
      { ItemID: "3", Code: "PARTS-IN", Name: "Bought only", IsSold: false },
      { ItemID: "4", Name: "No code" },
    ]),
    [
      { id: "1", code: "DEL", name: "Delivery", accountCode: null },
      { id: "2", code: "RXL", name: "Rover XL", accountCode: "4010" },
    ],
  );
  assert.deepEqual(parseXeroItemLink('{"id":"1","code":"DEL","name":"Delivery"}'), { id: "1", code: "DEL", name: "Delivery" });
  assert.equal(parseXeroItemLink(""), null);
  assert.equal(parseXeroItemLink("not json"), null);
  assert.equal(feeKindForXero("delivery"), "delivery");
  assert.equal(feeKindForXero("fee"), "other");
  assert.equal(feeKindForXero(null), "other");
});

// ── The customer ────────────────────────────────────────────────────────────

test("customer: email first, then exact name; archived skipped; two candidates refuse", () => {
  const contacts = [
    { ContactID: "a", Name: "Len Smith", EmailAddress: "len@example.com", ContactStatus: "ACTIVE" },
    { ContactID: "b", Name: "Len Smith (Stellenbosch)", EmailAddress: "", ContactStatus: "ACTIVE" },
    { ContactID: "c", Name: "Old Len", EmailAddress: "LEN@example.com", ContactStatus: "ARCHIVED" },
  ];
  assert.deepEqual(matchXeroContact(contacts, { name: "Someone else", email: " Len@Example.com " }), { kind: "match", contactId: "a" });
  assert.deepEqual(matchXeroContact(contacts, { name: "len smith", email: "" }), { kind: "match", contactId: "a" });
  assert.deepEqual(matchXeroContact(contacts, { name: "Len Smit", email: "" }), { kind: "none" }, "never a near match");
  const twins = [...contacts, { ContactID: "d", Name: "Len Smith", ContactStatus: "ACTIVE" }];
  assert.equal(matchXeroContact(twins, { name: "Len Smith", email: "" }).kind, "ambiguous");
  // The email search and the name search both return the same contact: still one match.
  assert.deepEqual(matchXeroContact([contacts[0], contacts[0]], { name: "Len Smith", email: "len@example.com" }), { kind: "match", contactId: "a" });
  assert.deepEqual(matchXeroContact([contacts[0], { ...contacts[0] }], { name: "Len Smith", email: "" }), { kind: "match", contactId: "a" });
  // Same name, different email: not silently the same person.
  assert.deepEqual(matchXeroContact(contacts, { name: "Len Smith", email: "len.other@example.com" }), { kind: "conflict", name: "Len Smith" });
  // Same name, Xero has no email on it: nothing contradicts the match.
  assert.deepEqual(matchXeroContact(contacts, { name: "Len Smith (Stellenbosch)", email: "x@example.com" }), { kind: "match", contactId: "b" });
});

test("a new Xero contact carries the CRM's billing details", () => {
  assert.deepEqual(
    buildXeroContact({ name: "Kaya Lodge", email: "accounts@kaya.co.za", phone: "021 555 0100", addressLines: ["1 Main Rd", "Constantia, Cape Town, 7806"], vatNumber: "4123456789" }),
    {
      Name: "Kaya Lodge",
      EmailAddress: "accounts@kaya.co.za",
      Phones: [{ PhoneType: "DEFAULT", PhoneNumber: "021 555 0100" }],
      Addresses: [{ AddressType: "POBOX", AddressLine1: "1 Main Rd", AddressLine2: "Constantia, Cape Town, 7806" }],
      TaxNumber: "4123456789",
    },
  );
  assert.deepEqual(buildXeroContact({ name: " ", email: "", phone: "", addressLines: [], vatNumber: "" }), { Name: "Customer" });
});

// ── Never two invoices; never the wrong books ──────────────────────────────

test("an invoice already in Xero for this quote is found by its Reference; voided ones don't count", () => {
  const ref = xeroReference({ number: 1029, invoiceNumber: 123 });
  const body = {
    Invoices: [
      { Type: "ACCREC", InvoiceID: "old", Reference: ref, Status: "VOIDED", Total: 1 },
      { Type: "ACCREC", InvoiceID: "live", InvoiceNumber: "INV-0042", Reference: ref, Status: "DRAFT", Total: 228000, Contact: { ContactID: "c-9" } },
    ],
  };
  assert.deepEqual(liveInvoiceWithReference(body, ref), { id: "live", number: "INV-0042", status: "DRAFT", totalCents: 22800000, contactId: "c-9" });
  assert.equal(liveInvoiceWithReference({ Invoices: [{ Type: "ACCREC", InvoiceID: "x", Reference: ref, Status: "DELETED" }] }, ref), null);
  assert.equal(liveInvoiceWithReference({ Invoices: [{ Type: "ACCREC", InvoiceID: "x", Reference: "INV-000124 / Q-1030", Status: "DRAFT" }] }, ref), null);
});

test("the organisation is the one from THIS consent, or the only one — never a guess", () => {
  const two = [
    { tenantId: "t1", tenantName: "Denago", tenantType: "ORGANISATION", authEventId: "e1" },
    { tenantId: "t2", tenantName: "Other Co", tenantType: "ORGANISATION", authEventId: "e0" },
  ];
  assert.deepEqual(chooseXeroOrganisation(two, "e1"), { tenantId: "t1", tenantName: "Denago" });
  assert.equal(chooseXeroOrganisation(two, null), null, "no event and two orgs → refuse");
  assert.equal(chooseXeroOrganisation(two, "e-unknown"), null);
  assert.deepEqual(chooseXeroOrganisation([two[0]], null), { tenantId: "t1", tenantName: "Denago" });
  assert.equal(chooseXeroOrganisation([{ ...two[0], authEventId: "e1" }, { ...two[1], authEventId: "e1" }], "e1"), null);
});

test("wiring: reconcile before create, lock the refresh, workspace money format, granular scopes", () => {
  const actions = readFileSync("src/app/actions/xero.ts", "utf8");
  assert.ok(actions.indexOf("findInvoiceByReference(reference)") < actions.indexOf("client.createInvoice("), "search Xero before creating");
  assert.match(actions, /requireQuoteAccess\(quoteId, "deliveries\.manage"\)/);
  assert.match(actions, /xeroStatus: "SENDING"/);
  assert.match(actions, /formatZAR\(crmTotal, moneyFmt\)/);
  assert.doesNotMatch(actions, /formatZAR\([^,)]+\)/, "every amount uses the workspace's format");
  const lib = readFileSync("src/lib/xero.ts", "utf8");
  assert.match(lib, /pg_advisory_xact_lock\(hashtext\(\$\{`xero-token:\$\{tenantId\}`\}\)\)/);
  assert.ok(lib.indexOf("pg_advisory_xact_lock") < lib.indexOf("grant_type: \"refresh_token\""), "lock before the refresh token is read and spent");
  const scopes = lib.match(/export const XERO_SCOPES = "([^"]+)"/)?.[1] ?? "";
  assert.match(scopes, /accounting\.invoices accounting\.contacts accounting\.settings\.read/);
  assert.doesNotMatch(scopes, /accounting\.transactions/);
  assert.match(lib, /process\.env\.XERO_CLIENT_ID/);
  assert.match(readFileSync("src/app/api/integrations/xero/callback/route.ts", "utf8"), /activeTenantId !== pending\.tenantId/);
});

// ── Invoices are final (Sean, 2026-11-11) ───────────────────────────────────

test("an invoice in Xero is locked until it is voided there", () => {
  const base = { number: 1029, invoiceNumber: 123, xeroInvoiceId: null, xeroInvoiceNumber: null, xeroStatus: null, xeroSentAt: null };
  const now = Date.parse("2026-11-11T10:00:00Z");
  assert.equal(xeroLockReason(base, now), null, "not in Xero → free");
  const inXero = { ...base, xeroInvoiceId: "x1", xeroInvoiceNumber: "INV-0042", xeroStatus: "AUTHORISED" };
  assert.match(xeroLockReason(inXero, now) ?? "", /^INV-000123 is in Xero as INV-0042, and an invoice is final\. Void it in Xero first/);
  assert.equal(xeroLockReason({ ...inXero, xeroStatus: "VOIDED" }, now), null, "voided in Xero → free");
  assert.equal(xeroLockReason({ ...inXero, xeroStatus: "DELETED" }, now), null);
  // Mid-send: locked. A send that never finished STAYS locked — the CRM can't know
  // whether Xero made it; only a send that checks Xero settles it (review of #1067).
  const sending = { ...base, xeroStatus: "SENDING", xeroSentAt: new Date(now - 30_000) };
  assert.match(xeroLockReason(sending, now) ?? "", /being sent to Xero right now/);
  assert.match(xeroLockReason({ ...sending, xeroSentAt: new Date(now - XERO_STALE_SEND_MS - 1) }, now) ?? "", /didn't finish.*Send invoice to Xero again/);
  assert.match(xeroLockReason({ ...sending, xeroSentAt: null }, now) ?? "", /didn't finish/);
  assert.ok(XERO_STALE_SEND_MS >= 15 * 60_000, "longer than a function can run");
});

test("every way to undo an accepted invoice asks xeroLockReason under the row lock", () => {
  const quotes = readFileSync("src/app/actions/quotes.ts", "utf8");
  const fn = (name: string) => quotes.slice(quotes.indexOf(`export async function ${name}(`), quotes.indexOf("\nexport ", quotes.indexOf(`export async function ${name}(`) + 1));
  for (const name of ["setQuoteStatus", "createQuoteRevision", "deleteQuote"]) {
    const body = fn(name);
    assert.ok(body.indexOf("FOR UPDATE") > 0 && body.indexOf("FOR UPDATE") < body.indexOf("xeroLockReason("), `${name}: lock, then ask`);
    assert.match(body, /if \(inXero\) throw new ActionRefusal\(inXero\);/, name);
  }
  const outcome = readFileSync("src/lib/quoteOutcome.ts", "utf8");
  const cancel = outcome.slice(outcome.indexOf("export async function cancelQuoteInTx("), outcome.indexOf("export async function duplicateQuoteInTx("));
  assert.match(cancel, /const inXero = xeroLockReason\(quote\);\s*if \(inXero\) return \{ kind: "refused", message: inXero \};/);
  // Sending re-checks status in the claim itself, so a cancel landing between read and claim can't be missed.
  const actions = readFileSync("src/app/actions/xero.ts", "utf8");
  assert.match(actions, /status: "accepted",\s*deletedAt: null,\s*supersededAt: null,\s*invoiceNumber: \{ not: null \},/);
  assert.match(actions, /quote\.status !== "accepted" \|\| !quote\.invoiceNumber/, "only an issued invoice is sent");
});

test("a PDF is filed only while the invoice still links that Xero invoice; a refresh that matched nothing stops", () => {
  const actions = readFileSync("src/app/actions/xero.ts", "utf8");
  const file = actions.slice(actions.indexOf("async function fileXeroPdf("), actions.indexOf("async function tryFilePdf("));
  const order = [
    "FOR UPDATE",
    "tx.quote.count({ where: { id: input.quote.id, tenantId: input.tenantId, xeroInvoiceId: input.invoice.id } })",
    "if (stillLinked !== 1) return false;",
    "tx.document.create(",
  ].map((s) => file.indexOf(s));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `lock, re-check the link, then file: ${order}`);
  assert.match(file, /if \(!filed\) throw new Error\(/, "an unfiled PDF is an error, and its stored copy is deleted");
  // ONE Xero PDF per invoice (Sean, 2026-11-11: "it files two copies"): every older live copy
  // for this invoice goes to the Trash in the same transaction as the new one is filed.
  assert.match(
    file,
    /tx\.document\.updateMany\(\{\s*where: \{ tenantId: input\.tenantId, quoteId: input\.quote\.id, tag: "accounting-invoice", deletedAt: null, id: \{ not: document\.id \} \},\s*data: \{ replacedById: document\.id, deletedAt: new Date\(\), deletedByName: "Xero", deleteReason:/,
  );
  const refresh = actions.slice(actions.indexOf("export async function refreshXeroInvoice("));
  assert.ok(refresh.indexOf("if (updated.count !== 1) refuse(") > 0 && refresh.indexOf("if (updated.count !== 1) refuse(") < refresh.indexOf("tryFilePdf("), "stop before any PDF when the update matched nothing");
});

test("void → resend fails → retry: the same replacement key every time, never the original's", () => {
  const id = "cq1";
  // First send.
  const first = xeroSendPlan({ id, xeroInvoiceId: null, xeroStatus: null });
  assert.deepEqual(first, { ok: true, replacing: null, idempotencyKey: "crm-quote-cq1" });
  // In Xero and live → no second send.
  assert.deepEqual(xeroSendPlan({ id, xeroInvoiceId: "old", xeroStatus: "AUTHORISED" }), { ok: false });
  // Voided in Xero (Refresh saw it) → a replacement, keyed on the voided invoice.
  const voided = { id, xeroInvoiceId: "old", xeroStatus: "VOIDED" };
  const replace = xeroSendPlan(voided);
  assert.deepEqual(replace, { ok: true, replacing: "old", idempotencyKey: "crm-quote-cq1-after-old" });
  // The replacement fails after asking Xero to create: UNCONFIRMED, and the link to "old" is untouched (the claim never clears it).
  const afterFail = { ...voided, xeroStatus: xeroStatusAfterFailedSend(voided.xeroStatus, true) };
  assert.equal(afterFail.xeroStatus, XERO_UNCONFIRMED);
  // The retry: the SAME key as the failed replacement — not the original send's.
  assert.deepEqual(xeroSendPlan(afterFail), { ok: true, replacing: "old", idempotencyKey: "crm-quote-cq1-after-old" });
  // A retry that fails BEFORE creating stays UNCONFIRMED (it was already uncertain), so the key holds again.
  assert.equal(xeroStatusAfterFailedSend(XERO_UNCONFIRMED, false), XERO_UNCONFIRMED);
  assert.deepEqual(xeroSendPlan({ ...afterFail, xeroStatus: xeroStatusAfterFailedSend(XERO_UNCONFIRMED, false) }), replace);
  // A replacement that fails before creating anything is just still voided — free to try again, same key.
  assert.equal(xeroStatusAfterFailedSend("VOIDED", false), "VOIDED");
  assert.equal(xeroStatusAfterFailedSend(null, false), null, "a first send that never reached Xero is simply unsent");
  // And it stays locked throughout the uncertainty.
  assert.match(xeroLockReason({ number: 1, invoiceNumber: 2, xeroInvoiceNumber: "INV-9", xeroSentAt: null, ...afterFail }) ?? "", /didn't finish/);
});

test("a delivered invoice (off the Deliveries board) can still be sent, from the customer", () => {
  const page = readFileSync("src/app/(app)/contacts/[id]/page.tsx", "utf8");
  assert.match(page, /contact\.quotes\.filter\(\(q\) => q\.status === "accepted" && q\.invoiceNumber && !q\.supersededAt\)/, "delivered ones are not filtered out");
  assert.match(page, /hasPermission\(user, "deliveries\.manage"\)/);
  assert.match(page, /<XeroInvoiceControl quote=\{q\} crmTotalCents=\{payableTotalCents\(q\)\} \/>/);
  assert.doesNotMatch(readFileSync("src/app/actions/xero.ts", "utf8"), /deliveredAt/, "sending doesn't refuse a delivered invoice");
});

test("connecting a DIFFERENT Xero organisation forgets every link to the old one", () => {
  const lib = readFileSync("src/lib/xero.ts", "utf8");
  const forget = lib.slice(lib.indexOf("async function forgetXeroLinks("));
  for (const model of ["quote", "contact", "fleet", "product", "appSetting"]) {
    assert.match(forget, new RegExp(`tx\\.${model}\\.updateMany\\(\\{\\s*where: \\{ tenantId,`), `${model} cleared, in this workspace only`);
  }
  // Atomic (review of #1067): token lock → read the OLD organisation → clear → save the new, in ONE transaction.
  const exchange = lib.slice(lib.indexOf("export async function exchangeXeroCode("), lib.indexOf("async function forgetXeroLinks("));
  const steps = [
    "await basePrisma.$transaction(",
    "pg_advisory_xact_lock(hashtext(${`xero-token:${input.tenantId}`}))",
    "previous && previous !== org.tenantId ? await forgetXeroLinks(tx, input.tenantId) : null",
    "await putTenantCredentialBundle(",
  ].map((s) => exchange.indexOf(s));
  assert.ok(steps.every((at, i) => at > 0 && (i === 0 || at > steps[i - 1])), `in order, in one transaction: ${steps}`);
  assert.match(exchange, /XERO_REFRESH_TOKEN: String\(tokens\.refresh_token\) \},\s*tx,\s*\)/, "the new connection is saved in the same transaction");
  assert.match(readFileSync("src/lib/settings.ts", "utf8"), /if \(inTx\) await write\(inTx\);\s*else await basePrisma\.\$transaction\(write\);/);
  // Said BEFORE the click, with what would be cleared (Sean, 2026-11-11).
  const settings = readFileSync("src/app/(app)/settings/integrations/page.tsx", "utf8");
  assert.match(settings, /Choosing a\s+different organisation clears this workspace&apos;s links to this one: \{xeroLinks\.invoices\} invoice/);
  assert.match(settings, /prisma\.quote\.count\(\{ where: \{ tenantId, xeroInvoiceId: \{ not: null \} \} \}\)/);
});

test("a send writes its result only while its own claim stands; a failed create stays UNCONFIRMED", () => {
  const actions = readFileSync("src/app/actions/xero.ts", "utf8");
  assert.match(actions, /const ourClaim = \{ id: quoteId, tenantId, xeroStatus: "SENDING", xeroSentAt: claimAt \};/);
  assert.match(actions, /const saved = await tx\.quote\.updateMany\(\{\s*where: ourClaim,/, "result recorded only under our claim");
  assert.match(actions, /if \(saved\.count !== 1\) return false;\s*\/\/ The customer's Xero contact/, "and the contact link with it, or neither");
  assert.match(actions, /where: ourClaim,\s*data: \{ xeroStatus: xeroStatusAfterFailedSend\(quote\.xeroStatus, createAttempted\) \},/);
  assert.ok(actions.indexOf("createAttempted = true;") < actions.indexOf("client.createInvoice(payload, plan.idempotencyKey)"));
  // The claim never clears the link: a voided invoice stays until its replacement is recorded.
  assert.match(actions, /data: \{ xeroStatus: "SENDING", xeroSentAt: claimAt \},/);
  assert.match(actions, /if \(xeroSendUncertain\(quote\.xeroStatus\)\) refuse\(/, "Refresh doesn't read the voided invoice back over a send");
  const unconfirmed = { number: 1, invoiceNumber: 5, xeroInvoiceId: null, xeroInvoiceNumber: null, xeroStatus: XERO_UNCONFIRMED, xeroSentAt: null };
  assert.match(xeroLockReason(unconfirmed) ?? "", /didn't finish/, "Xero may have it → locked until a send checks");
});

// ── Odds and ends ───────────────────────────────────────────────────────────

test("answers, labels and file names", () => {
  assert.deepEqual(readXeroInvoice({ Invoices: [{ InvoiceID: "abc", InvoiceNumber: "INV-0042", Status: "DRAFT", Total: 2345.67 }] }), {
    id: "abc", number: "INV-0042", status: "DRAFT", totalCents: 234567, contactId: null,
  });
  assert.equal(readXeroInvoice(null), null);
  assert.equal(xeroErrorMessage({ Elements: [{ ValidationErrors: [{ Message: "Account code '999' is not a valid code." }] }] }, 400), "Account code '999' is not a valid code.");
  assert.equal(xeroErrorMessage(null, 503), "Xero answered 503.");
  assert.equal(totalsDiffer(100_001, 100_000), false);
  assert.equal(totalsDiffer(100_500, 100_000), true);
  assert.equal(xeroStatusLabel("PAID"), "Paid");
  assert.equal(xeroPdfFileName("INV-0042", 1029), "INV-0042 Xero invoice.pdf");
  assert.equal(xeroPdfFileName(null, 1029), "Q-1029 Xero invoice.pdf");
  assert.ok(SYSTEM_DOCUMENT_TAGS.has("accounting-invoice"), "nobody can relabel it");
  assert.equal(SYSTEM_TAG_LABELS["accounting-invoice"], "Accounting invoice (Xero)");
});

test("each workspace holds only its own connection; the app's keys come from the hosting environment", () => {
  const xero = TENANT_CREDENTIAL_INTEGRATIONS.find((i) => i.id === "xero");
  assert.ok(xero);
  assert.ok(xero.fields.every((f) => f.independent && f.required === false));
  assert.ok(!xero.fields.some((f) => f.key === "XERO_CLIENT_ID" || f.key === "XERO_CLIENT_SECRET"));
  assert.ok(isSecretSettingKey("XERO_REFRESH_TOKEN"));
});
