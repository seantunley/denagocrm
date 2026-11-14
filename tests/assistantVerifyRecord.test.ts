import assert from "node:assert/strict";
import { test } from "node:test";
import { unsupportedFigures, unsupportedNote } from "../src/lib/assistantVerify";

/*
 * The checker binds a sentence to the record it names (DAX roadmap, Phase 2): a figure must be on THAT quote,
 * not merely somewhere in the lookups. Shapes below are what the lookups return (crmAssistant.ts).
 */

// find_quotes rows for two customers.
const quotes = [
  { quote: "Q-1040", link: "/quotes/werner", customer: "Werner Kilian", total: "R 256 500,00", lines: ["1 × Rover XL — colour white"], fees: ["Delivery — R 6 500,00"], status: "sent" },
  { quote: "Q-1041", link: "/quotes/anna", customer: "Anna Jacobs", total: "R 88 500,00", lines: ["1 × Golf caddie"], fees: ["Delivery — R 5 000,00"], status: "sent" },
];
// A lead brief for Werner: an OLD message promising R5 000 delivery; the quote inside it says R6 500.
const brief = [{
  id: "lead-w", link: "/leads/lead-w", customer: "Werner Kilian", value: "R 256 500,00",
  messages: [{ when: "2026-09-30", from: "Werner Kilian", channel: "whatsapp", text: "You said delivery would be R5 000?" }],
  quotes: [{ quote: "Q-1040", link: "/quotes/werner", total: "R 256 500,00", fees: ["Delivery — R 6 500,00"], status: "accepted", deposit: "not paid", delivery: "booked 2026-10-31" }],
}];
// deliveries: Anna's deposit is paid and delivery booked for 4 Nov.
const deliveries = [{ quote: "Q-1041", link: "/quotes/anna", customer: "Anna Jacobs", total: "R 88 500,00", deposit: "paid 2026-10-20 (R 10 000,00)", deliveryDate: "2026-11-04", delivered: null }];
const stock = [
  { unit: "STK-7", link: "/stock/s7", product: "Rover XL", status: "sold" },
  { unit: "STK-9", link: "/stock/s9", product: "Golf caddie", status: "available" },
];

test("a figure on the quote the sentence names passes — by number, link or customer", () => {
  assert.deepEqual(unsupportedFigures("Q-1040 comes to R 256 500 with delivery at R6 500.", [quotes]), []);
  assert.deepEqual(unsupportedFigures("Delivery is R6 500 [[/quotes/werner]].", [quotes]), []);
  assert.deepEqual(unsupportedFigures("Werner's quote has delivery at R6 500.", [quotes]), []);
  assert.deepEqual(unsupportedFigures("Anna's quote is R88 500.", [quotes]), []);
});

test("the same figure from ANOTHER customer's quote is flagged as a mix-up", () => {
  // R 88 500 is real — it's Anna's — but this sentence is about Werner's quote.
  assert.deepEqual(unsupportedFigures("Q-1040 is R 88 500.", [quotes]), ["R 88 500 (not on Q-1040)"]);
  assert.deepEqual(unsupportedFigures("Werner's quote comes to R 88 500.", [quotes]), ["R 88 500 (not on Q-1040)"]);
  assert.deepEqual(unsupportedFigures("Delivery is R5 000 [[/quotes/werner]].", [quotes]), ["R5 000 (not on Q-1040)"]);
  // Still flagged as before when it's nowhere at all.
  assert.deepEqual(unsupportedFigures("Q-1040 is R 99 999.", [quotes]), ["R 99 999"]);
});

test("contradicted old info: an old message says R5 000, the quote says R6 500", () => {
  // Wrong: the old message's figure stated as the quote's.
  assert.deepEqual(unsupportedFigures("Werner's quote has delivery at R5 000.", [brief]), ["R5 000 (not on Q-1040)"]);
  // Right: the quote's figure, and the old one reported as what was SAID — a separate fact, not the record's.
  assert.deepEqual(unsupportedFigures("Q-1040 has delivery at R6 500. On 30 Sep he wrote that it would be R5 000.", [brief]), []);
  assert.deepEqual(unsupportedFigures("Q-1040 charges R6 500 for delivery, not the R5 000 he mentioned.", [brief]), []);
});

test("\"My read:\" is not checked, and a proposed change carries new figures", () => {
  assert.deepEqual(unsupportedFigures("My read: Q-1040 at R5 000 delivery would close it.", [brief]), []);
  assert.deepEqual(unsupportedFigures("I'll change Q-1040's delivery to R5 000 — confirm below.", [brief, "make delivery R5 000"]), []);
});

test("deposit paid → the quote's deposit; delivery date → its delivery date", () => {
  assert.deepEqual(unsupportedFigures("Anna has paid the deposit on Q-1041.", [deliveries]), []);
  assert.deepEqual(unsupportedFigures("Werner's deposit on Q-1040 is paid.", [brief]), ["deposit paid (not on Q-1040)"]);
  assert.deepEqual(unsupportedFigures("Werner hasn't paid the deposit on Q-1040 yet.", [brief]), [], "a negative isn't a paid claim");
  assert.deepEqual(unsupportedFigures("Q-1040 delivery is booked for 31 Oct.", [brief]), []);
  assert.deepEqual(unsupportedFigures("Q-1041's delivery is on 4 November.", [deliveries]), []);
  assert.deepEqual(unsupportedFigures("Q-1040 delivery is booked for 4 Nov.", [brief, deliveries]), ["delivery 4 Nov (not on Q-1040)"]);
  assert.deepEqual(unsupportedFigures("Q-1040 was created on 3 Oct.", [brief]), [], "a date that isn't about delivery isn't checked");
});

test("in stock → the unit's status", () => {
  assert.deepEqual(unsupportedFigures("The Golf caddie is in stock.", [stock]), []);
  assert.deepEqual(unsupportedFigures("The Rover XL is in stock.", [stock]), ["in stock (Rover XL is sold)"]);
  assert.deepEqual(unsupportedFigures("The Rover XL is not in stock.", [stock]), []);
});

test("an email is never \"delivered\" or \"read\"", () => {
  assert.deepEqual(unsupportedFigures("The quote email was delivered on Monday.", [quotes]), ['email "delivered" (the CRM can only tell accepted, bounced or opened)']);
  assert.deepEqual(unsupportedFigures("Anna read your email yesterday.", [quotes]), ['email "read" (the CRM can only tell accepted, bounced or opened)']);
  assert.deepEqual(unsupportedFigures("The quote email bounced, so it was not delivered.", [quotes]), []);
  assert.deepEqual(unsupportedFigures("Our mail server accepted the email; no open detected.", [quotes]), []);
  assert.deepEqual(unsupportedFigures("We delivered her cart and emailed the invoice.", [quotes]), []);
});

/* ── Which record each claim belongs to (DAX_Conversational_Upgrades §5, 2026-11-14) ── */

test("ACCEPTANCE: two customers' totals swapped in one sentence — both caught, though both numbers are in the evidence", () => {
  assert.deepEqual(
    unsupportedFigures("Werner's quote is R 88 500 and Anna's is R 256 500.", [quotes]),
    ["R 88 500 (not on Q-1040)", "R 256 500 (not on Q-1041)"],
  );
  assert.deepEqual(unsupportedFigures("Werner's quote is R 256 500 and Anna's is R 88 500.", [quotes]), [], "the right way round passes");
  assert.deepEqual(unsupportedFigures("Q-1040 comes to R 88 500, Q-1041 to R 256 500.", [quotes]), ["R 88 500 (not on Q-1040)", "R 256 500 (not on Q-1041)"], "by quote number too");
  // A comma inside an amount is not a clause break.
  assert.deepEqual(unsupportedFigures("Werner's quote is R 256 500,00 and Anna's is R 88 500,00.", [quotes]), []);
});

test("by customer, without the word 'quote': a figure that is someone else's and nothing of theirs is flagged", () => {
  assert.deepEqual(unsupportedFigures("Werner's total is R 88 500.", [quotes]), ["R 88 500 (that's Anna Jacobs's, not Werner Kilian's)"]);
  assert.deepEqual(unsupportedFigures("Werner's total is R 256 500.", [quotes]), []);
  // Two customers named in one clause: no guess — a combined figure passes as before.
  assert.deepEqual(unsupportedFigures("Werner and Anna together come to R 345 000.", [quotes]), []);
  // Nobody named: only the presence check, as before.
  assert.deepEqual(unsupportedFigures("The biggest is R 256 500.", [quotes]), []);
  // What someone SAID is not the record's.
  assert.deepEqual(unsupportedFigures("Werner said Anna's was R 88 500.", [quotes]), []);
});

test("a deposit only requested is never 'paid'; a cleared one is — said with or without 'quote'", () => {
  assert.deepEqual(unsupportedFigures("Werner has paid his deposit.", [brief]), ["deposit paid (not on Q-1040)"], "brief shows it not paid");
  assert.deepEqual(unsupportedFigures("Anna has paid her deposit.", [deliveries]), []);
  // No lookup said anything about the deposit: nothing to contradict, no false alarm.
  assert.deepEqual(unsupportedFigures("Anna has paid her deposit.", [quotes]), []);
});

test("delivered (done) and delivery booked (promised) are different facts", () => {
  // Werner's delivery is BOOKED for 31 Oct; it hasn't happened.
  assert.deepEqual(unsupportedFigures("Werner's delivery is booked for 31 Oct.", [brief]), []);
  assert.deepEqual(unsupportedFigures("Werner's cart was delivered on 31 Oct.", [brief]), ["delivered 31 Oct (not on Q-1040)"]);
  const done = [{ quote: "Q-1041", link: "/quotes/anna", customer: "Anna Jacobs", deposit: "paid 2026-10-20", deliveryDate: "2026-11-04", delivered: "2026-11-04" }];
  assert.deepEqual(unsupportedFigures("Anna's cart was delivered on 4 Nov.", [done]), []);
  // Said without "quote", a delivery date is checked only against a quote whose lookup carried one.
  assert.deepEqual(unsupportedFigures("Anna's delivery is on 9 Dec.", [quotes]), []);
});

test("review of #1116: deposit and delivery claims are checked per owner, with negation scoped to its own part", () => {
  const annaDelivered = [{ quote: "Q-1041", link: "/quotes/anna", customer: "Anna Jacobs", deposit: "paid 2026-10-20", deliveryDate: "2026-11-04", delivered: "2026-11-04" }];
  // 1. Two paid claims, only Anna's true: Anna's paid deposit no longer vouches for Werner's.
  assert.deepEqual(unsupportedFigures("Werner has paid his deposit and Anna has paid hers.", [brief, deliveries]), ["deposit paid (not on Q-1040)"]);
  assert.deepEqual(unsupportedFigures("Anna has paid her deposit and Werner has paid his.", [brief, deliveries]), ["deposit paid (not on Q-1040)"], "either order");
  // 2. Two delivered claims, only Anna's true: Werner's is booked, not delivered.
  assert.deepEqual(unsupportedFigures("Werner's cart was delivered on 31 Oct and Anna's was delivered on 4 Nov.", [brief, annaDelivered]), ["delivered 31 Oct (not on Q-1040)"]);
  assert.deepEqual(unsupportedFigures("Werner's cart was delivered on 31 Oct and Anna's on 4 Nov.", [brief, annaDelivered]), ["delivered 31 Oct (not on Q-1040)"], "the verb carried into the second part");
  assert.deepEqual(unsupportedFigures("Werner's delivery is booked for 31 Oct and Anna's was delivered on 4 Nov.", [brief, annaDelivered]), [], "both true");
  // 3. A negated second part doesn't silence the first.
  assert.deepEqual(unsupportedFigures("Werner has paid his deposit and Anna has not paid hers.", [brief, deliveries]), ["deposit paid (not on Q-1040)"]);
  assert.deepEqual(unsupportedFigures("Anna has paid her deposit but Werner hasn't paid his.", [brief, deliveries]), [], "the negated part is not a claim");
  // One claim across several clauses still belongs to its owner.
  assert.deepEqual(unsupportedFigures("Werner's deposit, R 10 000, is paid.", [brief, deliveries]), ["R 10 000 (not on Q-1040)", "deposit paid (not on Q-1040)"]);
  // A part naming nobody, in a sentence about several quotes: no guess.
  assert.deepEqual(unsupportedFigures("The deposit is paid, for Werner and Anna.", [brief, deliveries]), []);
  // Missing lookup data is never a false flag, even when "quote" is said.
  assert.deepEqual(unsupportedFigures("Anna's quote deposit is paid.", [quotes]), []);
});

test("end to end, as the answer is checked: evidence shaped like the live call (question, history, lookups) → the note", () => {
  // crmAssistant: evidenceNow = [question, ...history questions, ...observations' data]; then unsupportedNote.
  const evidenceNow = ["Compare Werner's and Anna's quotes", "How are my deals?", quotes, deliveries];
  const swapped = unsupportedFigures("Werner's quote is R 88 500 and Anna's is R 256 500. Anna has paid her deposit.", evidenceNow);
  assert.deepEqual(swapped, ["R 88 500 (not on Q-1040)", "R 256 500 (not on Q-1041)"]);
  assert.match(unsupportedNote(swapped), /R 88 500 \(not on Q-1040\), R 256 500 \(not on Q-1041\)\. They may be worked out from them, or wrong/);
  assert.deepEqual(unsupportedFigures("Werner's quote is R 256 500 and Anna's is R 88 500. Anna has paid her deposit.", evidenceNow), []);
});
