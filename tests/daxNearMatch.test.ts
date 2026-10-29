import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { closestColour, closestNames, editDistance, nameCloseness, nameIsClose, nameStems, NEAR_NAME } from "../src/lib/nearMatch";
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

// Sean, 2026-10-29: "asked for clive jammim and it failed to find the client. can we not get dax to present the
// closest options instead of asking for the spelling". "Jammim" is two letters off "Jammine" — past nameIsClose's one
// slip — and only names sharing a word's first three letters, the fifty most recently changed, were ever looked at.
test("the closest names, closest first: 'clive jammim' → Clive Jammine, then Clive James; a different surname is not offered", () => {
  assert.ok(!nameIsClose("clive jammim", "Clive Jammine"), "what failed: two letters out was too far for a yes/no match");
  assert.ok(nameCloseness("clive jammim", "Clive Jammine") > nameCloseness("clive jammim", "Clive James"));
  assert.ok(nameCloseness("clive jammim", "Clive James") >= NEAR_NAME, "near enough to offer, after the closer one");
  const people = ["Clive Botha", "Benjamin Smith", "Clive James", "Clive Jammine", "Anna Jacobs"];
  assert.deepEqual(closestNames("clive jammim", people, (name) => [name]), ["Clive Jammine", "Clive James"]);
  // The first letters wrong (the old database search could never find these), and a transposition.
  assert.deepEqual(closestNames("Klive Jammine", people, (name) => [name]), ["Clive Jammine"]);
  assert.equal(closestNames("clive jmamine", people, (name) => [name])[0], "Clive Jammine");
  // What the yes/no rule already allowed still comes first, and a company's name counts too.
  assert.deepEqual(closestNames("Werner Killian", ["Werner Botha", "Werner Kilian"], (name) => [name]), ["Werner Kilian"]);
  assert.deepEqual(closestNames("Lagoon Lodj", [{ id: 1, names: ["Anna Jacobs", "Lagoon Lodge (Pty) Ltd"] }], (c) => c.names).map((c) => c.id), [1]);
  // At most five, and nothing for a name nowhere near.
  const many = Array.from({ length: 9 }, (_, i) => `Clive Jammine${"x".repeat(i)}`);
  assert.equal(closestNames("clive jammine", many, (name) => [name]).length, 5);
  assert.deepEqual(closestNames("Zola Mthembu", people, (name) => [name]), []);
});

test("no exact name: lead_brief offers the closest names as the choice — never 'no such customer', never 'spell it'", () => {
  const core = read("src/lib/crmAssistant.ts");
  const brief = core.slice(core.indexOf("export async function leadBrief("), core.indexOf("// Several match (\"Lisa\")"));
  assert.match(brief, /const close = looksLikeId \? \[\] : await nearlyNamed\(user, needle, ids\);/);
  assert.match(brief, /const offer = close\.slice\(0, 3\)\.map\(\(match\) => match\.name\)\.join\(", or "\);/);
  assert.match(brief, /Do NOT say there is no such customer, do NOT ask them to spell it or type it again, and do not act on a guess: offer \$\{close\.length === 1 \? "it" : "them"\} as a choice — "Did you mean \$\{offer\}\?"/);
  assert.match(brief, /closeMatches: close,/);
  // Every deal and customer the person may open, ranked by the database, in this workspace — raw SQL passes no guard.
  const near = core.slice(core.indexOf("async function nearlyNamed("), core.indexOf("export async function leadBrief("));
  assert.match(near, /const workspace = Prisma\.sql`\("tenantId" = \$\{tenantId\} OR \("tenantId" IS NULL AND \(SELECT count\(\*\) FROM "Tenant"\) = 1\)\)`;/);
  assert.match(near, /const tenantId = ownedWriteTenantId\(\);/);
  assert.equal((near.match(/WHERE "deletedAt" IS NULL AND \$\{workspace\}/g) ?? []).length, 2, "deals and customers both");
  assert.match(near, /AND \(\$\{leadIds === null\} OR "id" = ANY\(\$\{leadIds \?\? \[\]\}::text\[\]\)\)/);
  assert.match(near, /AND \(\$\{contactIds === null\} OR "id" = ANY\(\$\{contactIds \?\? \[\]\}::text\[\]\)\)/);
  assert.match(near, /return closestNames\(needle, \[\.\.\.deals, \.\.\.people\], \(candidate\) => candidate\.names\)/);
  assert.doesNotMatch(near, /take: 50|nameStems/, "no longer only the fifty most recent, by the first three letters");
});

test("DAX is told: a colour not offered → ask with the nearest; a name not found → the closest names as the choice", () => {
  assert.match(QUOTE_BUILD_RULE, /A COLOUR the product does not come in is not a dead end: ask with the nearest one it does/);
  assert.match(QUOTE_BUILD_RULE, /when lead_brief gives closeMatches, offer them as the choice, closest first \("Did you mean Clive Jammine, or Clive James\?"\) — never say there is no such customer, and never ask them to spell the name/);
  // A colour change on a quote the product doesn't come in names the nearest as a question.
  assert.match(read("src/lib/crmAssistant.ts"), /const near = closestColour\(wanted\.colour, colours\);[\s\S]{0,200}\$\{near \? ` Did you mean \$\{near\}\?` : ""\}/);
});
