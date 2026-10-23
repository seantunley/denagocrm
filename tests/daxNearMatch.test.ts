import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { closestColour, editDistance, nameIsClose, nameStems } from "../src/lib/nearMatch";
import { unsupportedFigures, wordAmounts } from "../src/lib/assistantVerify";
import { QUOTE_BUILD_RULE } from "../src/lib/assistantActions";

// Sean, 2026-10-23, by voice note on WhatsApp: "Give me a quote for Werner Killian, the Rover XL in dove gray and
// delivery to Hermanus, which is six thousand five hundred rand." The CRM has "Werner Kilian"; the Rover XL comes in
// Gray. DAX said there was no such customer, that the colour wasn't available, and flagged the fee he had said.
const ASKED = "Do me a favor. Give me a quote for Werner Killian, the Rover XL in dove gray and delivery to Hermanus, which is six thousand five hundred rand.";
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

test("a misspelt name is the same person: 'Werner Killian' is 'Werner Kilian' — a different surname is not", () => {
  assert.equal(editDistance("killian", "kilian"), 1);
  assert.ok(nameIsClose("Werner Killian", "Werner Kilian"));
  assert.ok(nameIsClose("werner kilian", "Werner Kilian"), "case");
  assert.ok(nameIsClose("Werner", "Werner Kilian"), "first name alone");
  assert.ok(!nameIsClose("Werner Killian", "Werner Botha"));
  assert.ok(!nameIsClose("Ann", "Anna Jacobs"), "a short word must match exactly");
  assert.deepEqual(nameStems("Werner Killian"), ["wer", "kil"], "what the database is searched by");
});

test("the nearest colour it comes in: 'Dove gray' → Gray, 'grey' → Gray, a typo → the colour; nothing near → none", () => {
  const roverXl = ["Black", "Blue", "Gray", "Lava", "Matte Black", "Verdant", "White"];
  assert.equal(closestColour("Dove gray", roverXl), "Gray");
  assert.equal(closestColour("grey", roverXl), "Gray");
  assert.equal(closestColour("matte black", roverXl), "Matte Black", "the longer colour that fits, not just Black");
  assert.equal(closestColour("Verdent", roverXl), "Verdant");
  assert.equal(closestColour("pink", roverXl), null);
});

test("an amount said in words is the person's own: R6 500 from 'six thousand five hundred rand' is not flagged", () => {
  assert.deepEqual(wordAmounts(ASKED), [6500]);
  assert.deepEqual(wordAmounts("two hundred and thirty-five thousand"), [235000]);
  assert.deepEqual(unsupportedFigures("The R6 500 Hermanus delivery fee is added after the draft is created.", [ASKED]), []);
  assert.deepEqual(unsupportedFigures("The R7 500 fee", [ASKED]), ["R7 500"], "a figure nobody said is still flagged");
});

test("no exact name: lead_brief offers the close matches and tells DAX to ask, not to say there's no such customer", () => {
  const core = read("src/lib/crmAssistant.ts");
  const brief = core.slice(core.indexOf("export async function leadBrief("), core.indexOf("// Several match (\"Lisa\")"));
  assert.match(brief, /const close = looksLikeId \? \[\] : await nearlyNamed\(user, needle, visible\);/);
  assert.match(brief, /Do NOT say there is no such customer, and do not act on the guess: ask "Did you mean \$\{close\[0\]\.name\}\?"/);
  assert.match(brief, /closeMatches: close,/);
  // Only what the person may see: their visible leads, and their accessible customers.
  const near = core.slice(core.indexOf("async function nearlyNamed("), core.indexOf("export async function leadBrief("));
  assert.match(near, /where: \{ deletedAt: null, \.\.\.visibleLeads,/);
  assert.match(near, /\.\.\.\(contactIds === null \? \{\} : \{ id: \{ in: contactIds \} \}\),/);
  assert.match(near, /nameIsClose\(needle, l\.name\)/);
});

test("DAX is told: a colour not offered → ask with the nearest; a name not found → 'Did you mean …?'", () => {
  assert.match(QUOTE_BUILD_RULE, /A COLOUR the product does not come in is not a dead end: ask with the nearest one it does/);
  assert.match(QUOTE_BUILD_RULE, /when lead_brief gives closeMatches, ask "Did you mean …\?" — never say there is no such customer/);
  // A colour change on a quote the product doesn't come in names the nearest as a question.
  assert.match(read("src/lib/crmAssistant.ts"), /const near = closestColour\(wanted\.colour, colours\);[\s\S]{0,200}\$\{near \? ` Did you mean \$\{near\}\?` : ""\}/);
});
