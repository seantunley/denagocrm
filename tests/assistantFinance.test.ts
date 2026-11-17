import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Module, { createRequire } from "node:module";
import type { FinanceCard } from "../src/lib/assistantFinanceRules";

// confirmFinanceCard against a finance row the test controls (review of #1139).
type Finance = { status: string; vendorId: string; reference: string | null; note: string | null; updatedAt: Date; statusAt: Date; vendor: { name: string } };
let financeNow: Finance | null = null;
type Loader = (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const moduleLoader = Module as unknown as { _load: Loader };
const realLoad = moduleLoader._load;
moduleLoader._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only") return {};
  if ((parent?.filename ?? "").replace(/\\/g, "/").endsWith("src/lib/assistantFinance.ts")) {
    if (request === "./dealFinance") return { loadDealFinance: async () => financeNow, loadFinanceDeals: async () => [], dealFinanceHouses: async () => [] };
    if (request === "./permissions") return { canAccessLead: async () => true, canAccessQuote: async () => true, getAccessibleQuoteIds: async () => null, hasPermission: async () => true };
    if (request === "./tenantWrite") return { ownedWriteTenantId: () => "tenant_a" };
    if (request === "./db") return { prisma: {} };
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;
const { confirmFinanceCard } = createRequire(import.meta.url)("../src/lib/assistantFinance.ts") as typeof import("../src/lib/assistantFinance");
import { parseSteps } from "../src/lib/crmAssistantPlan";
import { ACTION_INSTRUCTIONS, proposedAction } from "../src/lib/assistantActions";
import { FINANCE_RULE } from "../src/lib/assistantFinanceRules";
import { WHATSAPP_CONFIRMABLE } from "../src/lib/assistantWhatsAppRules";
import { familyOf } from "../src/lib/assistantOutcomeRules";

/*
 * DAX and finance (Sean, 2026-11-16): reads the Finance page's own list, and moves a deal's finance only through a
 * card the person confirms — the deal's own Save, with what the card showed checked again first.
 */

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

test("the finance lookup: planned like any other, by customer, status or what to chase", () => {
  const [step] = parseSteps('{"tool":"finance","args":{"customer":"Jody","toChase":true}}') ?? [];
  assert.deepEqual(step, { tool: "finance", args: { customer: "Jody", toChase: true } });
  assert.equal(parseSteps('{"tool":"finance","args":{"status":"maybe"}}'), null, "only a real status");
  const lookup = read("src/lib/assistantFinance.ts");
  assert.match(lookup, /loadFinanceDeals\(user, now, \{ active: !args\.all \}\)/, "the Finance page's own list: only deals this person may open");
  assert.equal(lookup.match(/if \(!\(await isModuleEnabled\("finance"\)\)\)/g)?.length, 2, "the Finance module: the lookup and the card");
  assert.doesNotMatch(lookup, /Enabled\("suppliers"\)/);
});

test("the card: proposed with a real status, shown before Confirm, and refused at Confirm if it moved since", () => {
  assert.ok(ACTION_INSTRUCTIONS.includes(FINANCE_RULE));
  assert.match(FINANCE_RULE, /never move it further than that/);
  const LEAD = "cmwgitom40004l307g474vwt7";
  assert.equal(proposedAction.safeParse({ type: "finance", leadId: LEAD, status: "approved", financeHouse: "WesBank" }).success, true);
  assert.equal(proposedAction.safeParse({ type: "finance", leadId: LEAD, status: "pending" }).success, false, "only a real status");
  const card = read("src/lib/assistantFinance.ts");
  assert.match(card, /hasPermission\(user, "leads\.edit"\)/);
  assert.match(card, /dealFinanceHouses\(tenantId, p\.leadId\)/, "only a finance house ON THIS DEAL — a cash deal gets no card");
  assert.match(card, /isn't on finance — add the finance house to the deal's suppliers/);
  assert.match(card, /never a guess/, "an unnamed house is the deal's own, else the only one — otherwise it asks");
  assert.match(card, /wasVersion: current\?\.updatedAt\.toISOString\(\) \?\? null/);
  assert.match(card, /Nobody is contacted\./);
  const confirm = read("src/app/actions/assistant.ts");
  assert.match(confirm, /case "finance": \{[\s\S]*?await saveDealFinance\(card\.quoteId, step\.form\)/, "the quote's own Save (finance is per quote)");
  // Which quote: named, else the one already financed, else the only one in play — never a guess between two.
  assert.equal(proposedAction.safeParse({ type: "finance", leadId: LEAD, quote: "Q-1045", status: "approved" }).success, true);
  assert.match(card, /return \{ problem: `Which quote's finance — /);
  assert.match(card, /quoteId: quote\.id, quoteNumber: quote\.number,/);
  assert.match(FINANCE_RULE, /"quote":"<Q-number, when the deal has more than one quote — finance is per quote>"/);
  assert.ok(WHATSAPP_CONFIRMABLE.has("finance"), "confirmable on WhatsApp too");
  assert.equal(familyOf("finance").key, "stage");
});

test("Confirm (review of #1139): a reference- or note-only card is carried out, and a colleague's edit since is never overwritten", async () => {
  const v1 = new Date("2026-11-16T09:00:00Z");
  const user = { id: "user_1" } as Parameters<typeof confirmFinanceCard>[0];
  financeNow = { status: "submitted", vendorId: "wesbank", reference: "APP-123", note: null, updatedAt: v1, statusAt: v1, vendor: { name: "WesBank" } };
  const card: FinanceCard = {
    id: "a0-lead", kind: "finance", leadId: "lead_1", leadLabel: "Jody", title: "Jody's finance on Q-1045: Submitted",
    quoteId: "quote_1045", quoteNumber: 1045,
    vendorId: "wesbank", status: "submitted", reference: "APP-999", note: null, wasVersion: v1.toISOString(), detail: "",
  };
  // Same status and house, a new reference: NOT done — it goes to the deal's own Save, with the version the card showed.
  const step = await confirmFinanceCard(user, card);
  assert.ok("form" in step, JSON.stringify(step));
  assert.equal(step.form.get("reference"), "APP-999");
  assert.equal(step.form.get("version"), v1.toISOString());
  // A note-only card likewise.
  assert.ok("form" in (await confirmFinanceCard(user, { ...card, reference: "APP-123", note: "approved subject to deposit" })));
  // Everything the card sets already stands: done, nothing saved.
  financeNow = { ...financeNow, reference: "APP-999", updatedAt: new Date("2026-11-16T09:05:00Z") };
  assert.deepEqual(await confirmFinanceCard(user, card), { done: true });
  // A colleague changed the note after the card was shown (same status): stale, nothing saved.
  financeNow = { ...financeNow, reference: "APP-123", note: "they called back", updatedAt: new Date("2026-11-16T09:10:00Z") };
  assert.ok("stale" in (await confirmFinanceCard(user, card)));
  // A card shown before the deal was financed, after someone started it: stale.
  assert.ok("stale" in (await confirmFinanceCard(user, { ...card, wasVersion: null })));
});
