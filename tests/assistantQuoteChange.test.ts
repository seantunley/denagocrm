import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { ACTION_INSTRUCTIONS, matchQuoteRow, quoteChangeText, splitActions, type QuoteChange } from "../src/lib/assistantActions";
import { WHATSAPP_CONFIRMABLE } from "../src/lib/assistantWhatsAppRules";

/*
 * Sean, 2026-10-12, three refusals in a row on a draft DAX had built:
 * "change description of delivery fee to Delivery Fee - Hermanus",
 * "remove delivery fee from Q-1030", "change color of rover from lava to white".
 * quote_change changes or removes rows that are already on a DRAFT, after a Confirm.
 */

const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const propose = (task: unknown) => splitActions(`ok\nACTIONS: ${JSON.stringify([task])}`).actions;

test("the three things he asked for can each be proposed — and a product's price cannot", () => {
  assert.equal(propose({ type: "quote_change", quote: "Q-1030", fees: [{ fee: "Delivery Fee", label: "Delivery Fee - Hermanus" }] }).length, 1);
  assert.equal(propose({ type: "quote_change", quote: "Q-1030", fees: [{ fee: "delivery fee", remove: true }] }).length, 1);
  assert.equal(propose({ type: "quote_change", quote: "Q-1030", lines: [{ line: "Rover", colour: "White" }] }).length, 1);
  assert.equal(propose({ type: "quote_change", quote: "Q-1030", lines: [{ line: "Rover", qty: 3, discountPct: 5 }] }).length, 1);
  // Refused: a price on a product line, a credit, a status, a customer, a recipient.
  for (const bad of [
    { lines: [{ line: "Rover", unitPrice: 1 }] },
    { lines: [{ line: "Rover", unitPriceCents: 1 }] },
    { lines: [{ line: "Rover", qty: 0 }] },
    { fees: [{ fee: "Delivery Fee", amount: -5 }] },
    { fees: [{ fee: "Delivery Fee", label: "x" }], status: "sent" },
    { fees: [{ fee: "Delivery Fee", label: "x" }], contactId: "cmcontactabcdefghijklmno" },
    { fees: [{ fee: "Delivery Fee", label: "x" }], to: "customer" },
  ]) {
    assert.deepEqual(propose({ type: "quote_change", quote: "Q-1030", ...bad }), [], JSON.stringify(bad));
  }
});

test("a name must mean exactly ONE row on the quote — never a guess", () => {
  const fees = [{ label: "Delivery Fee" }, { label: "Licensing" }];
  const name = (row: { label: string }) => row.label;
  assert.equal(matchQuoteRow(fees, name, "delivery fee")?.label, "Delivery Fee", "ignoring case");
  assert.equal(matchQuoteRow(fees, name, "delivery")?.label, "Delivery Fee", "the only one containing it");
  assert.equal(matchQuoteRow(fees, name, "fee")?.label, "Delivery Fee", "still the only one containing it");
  assert.equal(matchQuoteRow(fees, name, "i"), null, "both contain it");
  assert.equal(matchQuoteRow([{ label: "Delivery Fee" }, { label: "Delivery Fee - Hermanus" }], name, "delivery"), null, "two candidates");
  assert.equal(matchQuoteRow([{ label: "Delivery Fee" }, { label: "Delivery Fee - Hermanus" }], name, "Delivery Fee")?.label, "Delivery Fee", "an exact name wins over a longer one");
  assert.equal(matchQuoteRow([{ label: "Delivery Fee" }, { label: "delivery fee" }], name, "Delivery Fee"), null, "two rows called the same");
  assert.equal(matchQuoteRow(fees, name, "handling"), null);
  assert.equal(matchQuoteRow(fees, name, "  "), null);
});

test("the card shows each row before and after", () => {
  const changes: QuoteChange[] = [
    { row: "fee", id: "f1", was: { label: "Delivery Fee", amountCents: 5000_00 }, label: "Delivery Fee - Hermanus" },
    { row: "fee", id: "f2", was: { label: "Licensing", amountCents: 1500_00 }, remove: true },
    { row: "line", id: "i1", was: { description: "Denago EV Rover XL", qty: 1, discountPct: 0, colour: "Lava" }, colour: "White" },
    { row: "line", id: "i2", was: { description: "Denago EV Nomad", qty: 2, discountPct: 0, colour: null }, qty: 3, discountPct: 5 },
  ];
  assert.equal(quoteChangeText(changes, (cents) => `R${cents / 100}`), [
    'Fee "Delivery Fee" (R5000) → "Delivery Fee - Hermanus" (R5000)',
    'Remove: Fee "Licensing" (R1500)',
    "1 × Denago EV Rover XL (Lava) → 1 × Denago EV Rover XL (White)",
    "2 × Denago EV Nomad → 3 × Denago EV Nomad, less 5%",
    "Changed on the DRAFT — nothing else on it changes, and it is not sent to the customer.",
  ].join("\n"));
});

test("DAX is told it can, and it is confirmable on WhatsApp", () => {
  assert.match(ACTION_INSTRUCTIONS, /quote_change: CHANGE or REMOVE something already on a quote that is still a DRAFT/);
  assert.match(ACTION_INSTRUCTIONS, /never say you cannot rename, change or remove a fee or a line on a draft quote/);
  assert.match(ACTION_INSTRUCTIONS, /It cannot set a product's price/);
  assert.match(ACTION_INSTRUCTIONS, /"type":"quote_change","quote":"Q-1030","fees":\[\{"fee":"Delivery Fee","label":"Delivery Fee - Hermanus"\}\]/);
  assert.ok(WHATSAPP_CONFIRMABLE.has("quote_change"));
});

test("a card only for a draft they may edit and open, for rows that are on it, with a colour the product comes in", () => {
  const assistant = code("src/lib/crmAssistant.ts");
  const branch = assistant.slice(assistant.indexOf('if (p.type === "quote_change")'), assistant.indexOf('if (p.type === "quote_add")'));
  assert.match(branch, /hasPermission\(user, "quotes\.edit"\)\)\) continue;/);
  assert.match(branch, /quote\.status !== "draft" \|\| !quote\.contactId \|\| !\(await canAccessQuote\(user, quote\.id\)\)\) continue;/);
  assert.match(branch, /await prisma\.quote\.findFirst\(/);
  assert.match(branch, /matchQuoteRow\(quote\.fees, \(row\) => row\.label, wanted\.fee\)/);
  assert.match(branch, /matchQuoteRow\(quote\.items, \(row\) => row\.description, wanted\.line\)/);
  // One unclear target, or nothing actually changing, and there is no card — never part of what was asked.
  assert.match(branch, /if \(unclear \|\| changes\.length === 0\) continue;/);
  assert.match(branch, /line\.product\?\.colors\.find\(\(colour\) => colour\.name\.toLowerCase\(\) === wanted\.colour!\.toLowerCase\(\)\)\?\.name/);
  assert.match(branch, /if \(wanted\.colour && !offered\) \{ unclear = true; break; \}/);
  assert.match(branch, /confirmKey: `qk_\$\{randomBytes\(16\)\.toString\("hex"\)\}`,/);
});

test("Confirm hands the changes to the quote editor's save — once, and never as a send", () => {
  const action = code("src/app/actions/assistant.ts");
  const run = action.slice(action.indexOf('case "quote_change": {'), action.indexOf('case "quote_add": {'));
  assert.match(run, /if \(!CONFIRM_KEY\.test\(String\(card\.confirmKey \?\? ""\)\)\) return untouched\(STALE_CARD\);/);
  assert.match(run, /!quote \|\| !\(await hasPermission\(user, "quotes\.edit"\)\) \|\| !\(await canAccessQuote\(user, quote\.id\)\)\) return untouched/);
  assert.match(run, /quote\.status !== "draft" \|\| !quote\.contactId\) return untouched/);
  assert.match(run, /await saveQuoteDraft\(\{\s*id: quote\.id,\s*contactId: quote\.contactId,\s*terms: "",\s*intent: "draft",\s*items: \[\],\s*changes,\s*confirmKey: card\.confirmKey,\s*pdfToMyWhatsApp: true,\s*\}\);/);
  assert.doesNotMatch(run, /intent: "sent"|sendEmail|sendWhatsApp(Message|Text|Document)/);
  assert.match(run, /if \(!saved\.ok && saved\.repeated\) return \{ ok: true, success: "Already changed/);
});

test("UNDER THE LOCK: every row must still read as the card showed it, or nothing changes; then only those rows are written", () => {
  const quotes = code("src/app/actions/quotes.ts");
  const tx = quotes.slice(quotes.indexOf("const result = await basePrisma.$transaction(async (tx) => {"), quotes.indexOf("if (result === STALE) {"));
  const change = tx.slice(tx.indexOf("if (data.changes) {"), tx.indexOf("if (existing.leadId && existing.contactId && existing.contactId !== data.contactId) {"));
  assert.ok(change.length > 0);
  assert.ok(tx.indexOf("FOR UPDATE") < tx.indexOf("if (data.changes) {"));
  assert.ok(tx.indexOf("(await hasOpenSignatureRequest(tx, existing.id))") < tx.indexOf("if (data.changes) {"));
  // The check of every row comes before the key is spent and before any write.
  const firstWrite = Math.min(...["tx.quote.updateMany(", "tx.quoteFee.deleteMany(", "tx.quoteFee.updateMany(", "tx.quoteItem.deleteMany(", "tx.quoteItem.updateMany("].map((call) => change.indexOf(call)));
  assert.ok(change.lastIndexOf("return STALE;") < change.indexOf("claimConfirmKey(tx,"));
  assert.ok(change.indexOf("claimConfirmKey(tx,") < firstWrite);
  assert.match(change, /if \(!fee \|\| fee\.label !== change\.was\.label \|\| fee\.amountCents !== change\.was\.amountCents\) return STALE;/);
  assert.match(change, /!line \|\| line\.description !== change\.was\.description \|\| line\.qty !== change\.was\.qty \|\|\s*line\.discountPct !== change\.was\.discountPct \|\| \(line\.colorPreference \?\? null\) !== change\.was\.colour\s*\) return STALE;/);
  // A colour is checked against the line's own product, in the quote's workspace.
  assert.match(change, /tx\.product\.findFirst\(\{ where: \{ id: line\.productId, tenantId: ownerTenantId \}, select: \{ colors: \{ select: \{ name: true \} \} \} \}\)/);
  assert.match(change, /if \(!product\?\.colors\.some\(\(colour\) => colour\.name === change\.colour\)\) return STALE;/);
  // Each write names the row, THIS quote and its workspace — and must hit exactly one row.
  assert.equal((change.match(/where: \{ id: change\.id, quoteId: existing\.id, tenantId: ownerTenantId \}/g) ?? []).length, 4);
  assert.equal((change.match(/if \(done\.count !== 1\) throw new Error\(/g) ?? []).length, 2);
  // No price, no cost, no optional/selected, no header field is settable.
  assert.doesNotMatch(change, /unitPriceCents|costCents|optional:|selected:|data\.terms|validUntil|cpqQuoteData|contactId: data\.contactId|createMany/);
  assert.match(change, /if \(data\.intent !== "draft" \|\| existing\.contactId !== data\.contactId\) return null;/);
  // The schema bounds every value and admits no other field on a change.
  const schema = quotes.slice(quotes.indexOf("changes: z.array(z.discriminatedUnion(\"row\", ["), quotes.indexOf("confirmKey: z.string().regex(CONFIRM_KEY)"));
  assert.equal((schema.match(/\}\)\.strict\(\),/g) ?? []).length, 2);
  assert.match(schema, /amountCents: z\.number\(\)\.int\(\)\.positive\(\)\.max\(100_000_000\)\.optional\(\),/);
  assert.match(schema, /qty: z\.number\(\)\.int\(\)\.min\(1\)\.max\(500\)\.optional\(\),/);
  assert.doesNotMatch(schema, /unitPriceCents/);
  assert.match(quotes, /if \(result === STALE\) \{\s*return \{ ok: false, error: "That quote has changed since this was suggested, so nothing was changed\./);
});
