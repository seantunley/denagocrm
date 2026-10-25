import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { catalogueColour } from "../src/lib/nearMatch";
import { expandNumberedReply, PENDING_ACTION_TTL_MS, typedYes } from "../src/lib/assistantWhatsAppRules";
import { parseActionList, quoteBuildText, QUOTE_BUILD_RULE } from "../src/lib/assistantActions";

// Sean, 2026-10-24, on WhatsApp: a quote for Werner Kilian, Rover XL in grey, delivery to Hermanus R6 500. DAX could
// not see the colours, did not understand "2", and his final "Yes" got "there is nothing to confirm": the deal had no
// customer record, and the quote was dropped without a word. "Check all the potential bottlenecks, this needs to work."
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const core = read("src/lib/crmAssistant.ts");
const build = core.slice(core.indexOf('if (p.type === "quote_build") {'), core.indexOf("if (!(await canAccessLead(user, p.leadId))) continue;"));
const confirm = read("src/app/actions/assistant.ts");
const run = confirm.slice(confirm.indexOf('case "quote_build": {'), confirm.indexOf('case "quote_change": {'));

test("DAX sees each product's colours in the catalogue lookup", () => {
  assert.match(read("src/lib/catalogueLookup.ts"), /colors: \{ select: \{ name: true \}, orderBy: \{ name: "asc" \} \},/);
  assert.match(core, /colours: p\.colors\.map\(\(colour\) => colour\.name\),/);
});

test("the colour as the catalogue spells it: 'grey' is Gray; 'Dove gray' is a question", () => {
  const roverXl = ["Black", "Blue", "Gray", "Lava", "Matte Black", "Verdant", "White"];
  assert.equal(catalogueColour("grey", roverXl), "Gray");
  assert.equal(catalogueColour("GRAY", roverXl), "Gray");
  assert.equal(catalogueColour("matte black", roverXl), "Matte Black");
  assert.equal(catalogueColour("Dove gray", roverXl), null);
  assert.match(build, /const colour = line\.colour \? catalogueColour\(line\.colour, offered\) \?\? undefined : undefined;/);
  assert.match(build, /if \(colourProblem\) \{ problems\.push\(colourProblem\); continue; \}/);
});

test("review of #905: a product with NO colours set — asked, not offered as a card that Confirm would refuse", () => {
  // No colours: catalogueColour finds nothing, so a colour asked for is a question, never passed through.
  assert.equal(catalogueColour("grey", []), null);
  assert.match(build, /if \(line\.colour && !colour\) \{/);
  assert.match(build, /: `The \$\{product\.name\} has no colours set in the catalogue, so the quote can't say "\$\{line\.colour\}"\. Shall I leave the colour off\?`;/);
});

test("a quote can carry the fee said with it — one Confirm, not a second quote_add needing a number", () => {
  const parsed = parseActionList([{ type: "quote_build", leadId: "cmujc2eaj0001k304yja5469h", lines: [{ productId: "cmprod00000000000001", qty: 1, colour: "Gray" }], fees: [{ label: "Delivery — Hermanus", amount: 6500, delivery: true }] }]);
  assert.equal(parsed.length, 1, "fees on a quote_build no longer make the whole proposal invalid");
  const text = quoteBuildText(
    [{ productId: "p", description: "Denago EV Rover XL", qty: 1, unitPriceCents: 23_500_000, discountPct: 0, colour: "Gray" }],
    (c) => `R${c / 100}`,
    { fees: [{ label: "Delivery — Hermanus", amountCents: 650_000, delivery: true }], newCustomer: "Werner Kilian" },
  );
  assert.match(text, /1 × Denago EV Rover XL \(Gray\) — R235000 each/);
  assert.match(text, /Delivery: Delivery — Hermanus — R6500/);
  assert.match(text, /Werner Kilian becomes a customer record too/);
  assert.match(QUOTE_BUILD_RULE, /goes IN the same quote_build as \\?"fees\\?"/);
  assert.match(run, /fees: buildFees\.map\(\(fee\) => \(\{ label: String\(fee\.label\)\.trim\(\), kind: fee\.delivery \? "delivery" as const : "fee" as const, amountCents: fee\.amountCents \}\)\)/, "and the fees are SAVED");
});

test("a deal with no customer record: Confirm makes the customer (Add to contacts), it is not dropped", () => {
  assert.match(build, /else if \(await hasPermission\(user, "leads\.link_contact"\)\) createCustomer = true;/);
  assert.match(build, /else \{ problems\.push\(`\$\{deal\.name\}'s deal has no customer record yet, and your role can't create one/);
  assert.match(run, /if \(card\.createCustomer && !card\.contactId\) \{\s*if \(lead\.contactId\) quoteContactId = lead\.contactId;\s*else customerFromDeal = card\.leadId;/);
  // Made only after every check — a refusal before it changes nothing.
  assert.match(run, /if \(customerFromDeal\) \{\s*const made = await convertLeadToContact\(customerFromDeal\);/);
  assert.ok(run.lastIndexOf("return untouched(", run.indexOf("convertLeadToContact(customerFromDeal)")) > -1);
  assert.equal(run.slice(run.indexOf("convertLeadToContact(customerFromDeal)"), run.indexOf('case "quote_pdf": {')).includes("untouched("), false);
});

test("every way a quote proposal is dropped now says why — none silent", () => {
  assert.doesNotMatch(build, /\) continue;/, "no bare `continue` left in the quote_build path");
  for (const why of ["Your role can't create quotes.", "I can't open that deal for you", "That deal is no longer there.", "I can't open that customer for you", "That customer is no longer there.", "The quote didn't say which customer or deal it is for", "Not one product in the catalogue"]) {
    assert.ok(build.includes(why), why);
  }
});

test("Confirm: checked first (no redirect on a phone), before anything is written; a repeat is not a failure", () => {
  assert.match(run, /if \(!\(await hasPermission\(user, "quotes\.create"\)\)\) return untouched\("Your role can't create quotes\."\);/);
  assert.match(run, /if \(card\.contactId && !\(await canAccessContact\(user, card\.contactId\)\)\) return untouched\(/);
  assert.ok(run.indexOf('hasPermission(user, "quotes.create")') < run.indexOf("convertLeadToContact("), "before the customer record is made");
  assert.match(run, /if \(!saved\.ok && "repeated" in saved && saved\.repeated\) return \{ ok: true, success: "Already created/);
});

/*
 * DAX CAN SEE EVERYTHING A QUOTE IT PROPOSES NEEDS (Sean, 2026-10-25: "You assured me it had access to EVERYTHING it
 * needed to make quotes" — it could not see colours: the save took a colour, the lookup never showed one). Every field
 * a quote_build may carry is listed here with where its value comes from. A field added to the proposal without a
 * place here fails this test, and so does a lookup that stops showing what a field needs.
 */
test("DAX sees every value a quote it proposes needs, and proposes nothing the save would refuse", () => {
  const actions = read("src/lib/assistantActions.ts");
  const proposal = actions.slice(actions.indexOf('type: z.literal("quote_build"),'), actions.indexOf('type: z.literal("quote_add")'));
  const fields = (indent: number) => [...proposal.matchAll(new RegExp(`^ {${indent}}(\\w+)[:,]`, "gm"))].map((m) => m[1]);
  const feeFields = [...(/fees: z\.array\(\s*z\.object\(\{([^}]*)\}\)/.exec(proposal)?.[1] ?? "").matchAll(/(\w+):/g)].map((m) => m[1]);
  // Where each value comes from. "said" = the person says it (DAX asks if it isn't said).
  const SOURCE: Record<string, string> = {
    type: "fixed", leadId: "deal lookup", contactId: "customer lookup", lines: "list", fees: "list", reason: "DAX's own words",
    productId: "catalogue lookup", product: "catalogue lookup", colour: "catalogue lookup", qty: "said", discountPct: "said",
    label: "said", amount: "said", delivery: "said",
  };
  // (Not vacuous: the top-level fields and a line's are both found.)
  assert.deepEqual(fields(4), ["leadId", "contactId", "lines", "fees", "reason"]);
  assert.deepEqual(fields(8), ["productId", "product", "qty", "discountPct", "colour"]);
  assert.deepEqual(feeFields, ["label", "amount", "delivery"]);
  for (const field of [...fields(4), ...fields(8), ...feeFields]) assert.ok(SOURCE[field], `quote_build field "${field}" has no source DAX can see — add the lookup, then list it here`);

  // The catalogue lookup shows each catalogue-sourced value…
  const lookup = read("src/lib/catalogueLookup.ts");
  const fieldsShown = lookup.slice(lookup.indexOf("const KNOWLEDGE_FIELDS = {"), lookup.indexOf("} as const;", lookup.indexOf("const KNOWLEDGE_FIELDS = {")));
  for (const column of ["id: true", "name: true", "basePriceCents: true", "colors: { select: { name: true }"]) assert.ok(fieldsShown.includes(column), `the knowledge lookup selects ${column}`);
  for (const shown of ["productId: p.id,", "product: p.name,", "price: formatZAR(p.basePriceCents),", "colours: p.colors.map((colour) => colour.name),"]) assert.ok(core.includes(shown), `…and hands DAX ${shown}`);
  // …to anyone who may create a quote; the deal and customer lookups hand over the ids a card names.
  assert.match(core, /const seesProducts = await hasAnyPermission\(user, [^)]*"quotes\.create"\);/);
  assert.match(core, /kind: "deal" as const, leadId: l\.id,/);
  assert.match(core, /kind: "customer" as const, contactId: c\.id,/);
  // Stock (what's on the floor, in which colour) is its own lookup.
  assert.match(core, /colour: u\.color, location: u\.location,/);

  // The proposal's limits sit INSIDE the save's: nothing DAX may propose is refused for size by saveQuoteDraft.
  const quotes = read("src/app/actions/quotes.ts");
  assert.match(proposal, /qty: z\.number\(\)\.int\(\)\.min\(1\)\.max\(500\)/);
  assert.match(quotes, /qty: z\.number\(\)\.finite\(\)\.positive\(\)\.max\(100_000\)/);
  assert.match(proposal, /colour: text\.max\(60\)/);
  assert.match(quotes, /colorPreference: z\.string\(\)\.trim\(\)\.max\(100\)/);
  assert.match(proposal, /label: text\.max\(120\)/);
  assert.match(quotes, /label: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(120\),/);
  assert.match(proposal, /\.max\(QUOTE_ADD_MAX_FEES\)/);
  assert.match(quotes, /\.max\(20\)\.optional\(\),/);
  assert.match(actions, /export const QUOTE_ADD_MAX_FEES = 5;/);
  assert.match(actions, /export const QUOTE_BUILD_MAX_LINES = 10;/);
  assert.match(quotes, /\.max\(100, "A quote can contain at most 100 lines\."\)/);
  // And the save's content refusals are each met before a card is offered (the resolver) and again at Confirm,
  // before the customer record: the product on sale, the colour configured for it.
  assert.match(quotes, /return \{ ok: false, error: "A product on this quote is no longer available\." \}/);
  assert.match(quotes, /is not configured for this product\.` \}/);
  assert.ok(run.indexOf("The catalogue changed since DAX suggested this") < run.indexOf("convertLeadToContact("));
  assert.ok(run.indexOf("if (lines.some(notOffered)) return untouched(") < run.indexOf("convertLeadToContact("));
});

test("on WhatsApp: a typed 'yes' is the tap when ONE Confirm is waiting; '2' is the second option; an hour to confirm", () => {
  for (const yes of ["Yes", "yes please", "Confirm", "ja", "ok", "Go ahead!", "👍"]) assert.ok(typedYes(yes), yes);
  for (const no of ["Yes, but make it white", "no", "yesterday", "2"]) assert.ok(!typedYes(no), no);
  const wa = read("src/lib/assistantWhatsApp.ts");
  assert.match(wa, /if \(!pendingId && "text" in input && !input\.choiceId && typedYes\(input\.text\)\) \{[\s\S]{0,400}take: 2,[\s\S]{0,80}if \(live\.length === 1\) pendingId = live\[0\]\.id;/);
  const asked = "Did you mean Werner Kilian?\n\n1. Yes, Werner Kilian — leave colour open\n2. Yes, Werner Kilian — check gray first";
  assert.equal(expandNumberedReply("2", asked), "Yes, Werner Kilian — check gray first (option 2)");
  assert.equal(expandNumberedReply("3", asked), "3", "no such option: unchanged");
  assert.equal(expandNumberedReply("Werner", asked), "Werner");
  assert.equal(PENDING_ACTION_TTL_MS, 60 * 60 * 1000);
  assert.match(wa, /if \(delivered === "failed" \|\| delivered === "more"\) \{\s*await sendPlan\(waId, \{ texts: \["The PDF is on its way/);
});
