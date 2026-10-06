import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { unsupportedFigures, unsupportedNote } from "../src/lib/assistantVerify";

// What a quotes lookup returns: formatZAR's en-ZA shape, with its odd spaces.
const quotes = [
  { quote: "Q-1022", customer: "Anna", total: "R 412 000,00", link: "/quotes/a" },
  { quote: "Q-1023", customer: "Ben", total: "R 88 500,50", link: "/quotes/b" },
];

test("figures that are in the results pass, however they're written", () => {
  assert.deepEqual(unsupportedFigures("Anna's Q-1022 is R412,000 and Ben's is R 88 500,50.", [quotes]), []);
  assert.deepEqual(unsupportedFigures("Anna's quote is about R412k; Ben's R88 500.", [quotes]), [], "rounded as written");
  assert.deepEqual(unsupportedFigures("Together R 500 500,50.", [quotes]), [], "a list's column total");
  assert.deepEqual(unsupportedFigures("About R0.5m between them.", [quotes]), []);
});

test("an invented amount or a wrong quote number is flagged", () => {
  assert.deepEqual(unsupportedFigures("Anna's Q-1022 is R 421 000.", [quotes]), ["R 421 000"]);
  assert.deepEqual(unsupportedFigures("Ben signed Q-1099.", [quotes]), ["Q-1099"]);
  assert.deepEqual(unsupportedFigures("It's R2.5m.", [quotes]), ["R2.5m"]);
});

test("what the person said counts; DAX's own judgement isn't checked", () => {
  assert.deepEqual(unsupportedFigures("Within your R50 000 budget: Ben's.", ["Anything under R50 000?", quotes]), []);
  assert.deepEqual(unsupportedFigures("My read: offer R5 000 off to close it.", [quotes]), []);
  assert.deepEqual(unsupportedFigures("No figures here, 3 deals open.", [quotes]), []);
});

test("the note names what to check, and is said once", () => {
  assert.match(unsupportedNote(["R 421 000"]), /R 421 000\. It may be worked out from them, or wrong/);
  assert.match(unsupportedNote(["a", "b", "c", "d", "e", "f"]), /a, b, c, d and 2 more\. They may/);
});

test("every answer goes through the check, and the note is part of what's saved and shown", () => {
  const src = readFileSync(new URL("../src/lib/crmAssistant.ts", import.meta.url), "utf8");
  assert.match(src, /const flagged = unsupportedFigures\(resolved\.plain, \[question, conversation, \.\.\.observations\.map\(\(o\) => o\.output\.data\)\]\);/);
  assert.match(src, /const cited = resolved\.cited \+ note;\s*const answer = resolved\.plain \+ note;/);
  const plan = readFileSync(new URL("../src/lib/crmAssistantPlan.ts", import.meta.url), "utf8");
  assert.match(plan, /with \\"My read:\\"/);
  assert.match(plan, /with \\"Not in the CRM:\\"/);
});
