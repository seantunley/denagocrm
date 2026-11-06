import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  COMMON_CURRENCIES,
  currencyOf,
  parseEnabledCurrencies,
  storedCurrency,
  totalsByCurrency,
  withCurrency,
} from "../src/lib/currencyRules";
import { MODULE_REGISTRY } from "../src/lib/modules/registry";
import { grantedModuleIds } from "../src/lib/modules/entitlement";

const src = (rel: string) => readFileSync(rel, "utf8");
const ZAR = { currency: "ZAR", locale: "en-ZA" };

/* ── the pure rules ─────────────────────────────────────────────────────── */

test("enabled currencies: the base first, valid codes only, no repeats", () => {
  assert.deepEqual(parseEnabledCurrencies("RUB, usd ,RUB,xx,ZAR", "ZAR"), ["ZAR", "RUB", "USD"]);
  assert.deepEqual(parseEnabledCurrencies(null, "ZAR"), ["ZAR"]);
  assert.ok(COMMON_CURRENCIES.includes("RUB"));
});

test("NULL on a record is the base; a record's currency overrides only the currency", () => {
  assert.equal(currencyOf({ currency: null }, "ZAR"), "ZAR");
  assert.equal(currencyOf({ currency: "RUB" }, "ZAR"), "RUB");
  assert.deepEqual(withCurrency(ZAR, "RUB"), { currency: "RUB", locale: "en-ZA" });
  assert.equal(withCurrency(ZAR, null), ZAR, "no currency = the same format object");
  const regional = { ...ZAR, vatRatePct: 15, timeZone: "Africa/Johannesburg" };
  assert.equal(withCurrency(regional, "RUB").timeZone, "Africa/Johannesburg", "dates keep the workspace's settings");
});

test("storing a picked currency: the base is stored as NULL, an unoffered one is refused", () => {
  const options = { base: "ZAR", enabled: ["ZAR", "RUB"] };
  assert.deepEqual(storedCurrency("ZAR", options), { ok: true, currency: null });
  assert.deepEqual(storedCurrency("", options), { ok: true, currency: null });
  assert.deepEqual(storedCurrency("rub", options), { ok: true, currency: "RUB" });
  assert.equal(storedCurrency("USD", options).ok, false);
});

test("totals are per currency, base first — never one figure across currencies", () => {
  const rows = [
    { cents: 100, currency: null },
    { cents: 486100, currency: "RUB" },
    { cents: 50, currency: "ZAR" },
  ];
  assert.deepEqual(totalsByCurrency(rows, (row) => row, "ZAR"), [
    { currency: "ZAR", cents: 150 },
    { currency: "RUB", cents: 486100 },
  ]);
});

/* ── the module is opt-in and inert when off ─────────────────────────────── */

test("multicurrency is an optional module, granted per workspace — off unless granted", () => {
  const entry = MODULE_REGISTRY.find((module) => module.id === "multicurrency");
  assert.ok(entry && !entry.mandatory, "registered and optional");
  assert.equal(grantedModuleIds("core,inbox").has("multicurrency"), false, "an existing workspace's grant doesn't include it");
  const options = src("src/lib/currency.ts");
  assert.match(options, /if \(!on\) return \{ base: regional\.currency, enabled: \[regional\.currency\], on: false \};/,
    "module off = the base alone, so no picker shows anywhere");
  assert.match(src("src/app/actions/settings.ts"), /if \(!\(await isModuleEnabled\("multicurrency"\)\)\) throw new ActionRefusal/);
});

test("the columns are additive and NULL = the base", () => {
  const sql = src("prisma/migrations/20261106200000_multicurrency_lead_quote/migration.sql");
  assert.match(sql, /ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "currency" TEXT;/);
  assert.match(sql, /ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "currency" TEXT;/);
  assert.doesNotMatch(sql, /DROP|UPDATE|DEFAULT/i, "no existing row is touched");
});

/* ── leads and quotes ────────────────────────────────────────────────────── */

test("a lead form without the picker leaves the stored currency alone", () => {
  const leads = src("src/app/actions/leads.ts");
  assert.match(leads, /formData\.has\("currency"\) \? storedCurrency\(str\("currency"\), options\) : null/);
  assert.match(leads, /const currency = picked\?\.ok \? picked\.currency : undefined;/);
});

test("a lead's currency is fixed once it has a quote", () => {
  assert.match(src("src/app/actions/leads.ts"), /if \(quoted > 0\) throw new ActionRefusal\("This lead already has a quote, so its currency can't change/);
});

test("a quote on a lead is in the lead's currency; a quote from a lead inherits it", () => {
  assert.match(src("src/app/actions/quotes.ts"), /currency: linkedLead \? linkedLead\.currency \?\? null : pickedCurrency\.ok \? pickedCurrency\.currency : null,/);
  const seed = src("src/lib/quoteFromLead.ts");
  assert.match(seed, /currency: lead\.currency \?\? null,/);
  assert.match(seed, /lead\.valueCents \|\| \(lead\.currency \? 0 : lead\.product\.basePriceCents\)/,
    "the catalogue price (base currency) is never seeded into another currency");
});

test("documents, emails and payments say amounts in the quote's own currency", () => {
  assert.match(src("src/lib/docbuilder/merge.ts"), /const r = withCurrency\(regional, quote\.currency\);/);
  assert.match(src("src/lib/pdf/QuoteDoc.tsx"), /withCurrency\(regional, quote\.currency\)/);
  assert.match(src("src/app/actions/quoteEmail.ts"), /withCurrency\(await getRegionalSettings\(\), quote\.currency\)/);
  assert.match(src("src/app/actions/quotePayments.ts"), /parseMoneyInput\(String\(formData\.get\("amount"\) \?\? ""\), quoteMoney\.currency\)/);
  assert.match(src("src/lib/email.ts"), /formatZAR\(lead\.valueCents, withCurrency\(money, lead\.currency\)\)/, "{{value}} in journeys and templates");
});

/* ── never across currencies ─────────────────────────────────────────────── */

test("a statement covers one currency", () => {
  const loader = src("src/lib/accountStatementLoader.ts");
  assert.match(loader, /code === base \? \{ OR: \[\{ currency: null \}, \{ currency: base \}\] \} : \{ currency: code \}/);
  assert.match(loader, /where: \{ contactId, tenantId, \.\.\.money\.where \}/);
  assert.match(loader, /where: \{ fleetId, tenantId, \.\.\.money\.where \}/);
});

test("a payment only matches invoices in its own currency", () => {
  const match = src("src/lib/assistantPaymentMatch.ts");
  assert.match(match, /\.\.\.\(paidIn === base \? \{ OR: \[\{ currency: null \}, \{ currency: base \}\] \} : \{ currency: paidIn \}\)/);
});

test("board columns and the leads list total per currency", () => {
  assert.match(src("src/components/KanbanBoard.tsx"), /totalsByCurrency\(stage\.leads/);
  assert.match(src("src/app/(app)/leads/list/page.tsx"), /prisma\.lead\.groupBy\(\{ by: \["currency"\], where, _sum: \{ valueCents: true \} \}\)/);
});
