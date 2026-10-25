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
  assert.match(build, /const colour = !line\.colour \? undefined : offered\.length \? catalogueColour\(line\.colour, offered\) \?\? undefined : line\.colour;/);
  assert.match(build, /if \(colourProblem\) \{ problems\.push\(colourProblem\); continue; \}/);
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
  assert.match(run, /if \(!saved\.ok && saved\.repeated\) return \{ ok: true, success: "Already created/);
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
