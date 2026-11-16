import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { matchFinanceEmail } from "../src/lib/dealFinanceRules";

/*
 * An email from a finance house is filed on the ONE financed deal it names (Sean, 2026-11-16) — by its application
 * reference, else the customer's full name — never guessed between two, and never stored with its attachments.
 */

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const deals = [
  { id: "f1", reference: "APP-77", customer: "Jody Van Heerden" },
  { id: "f2", reference: "APP-778", customer: "Grant Smith" },
  { id: "f3", reference: null, customer: "Derek Lallyett" },
];
const match = (text: string, list = deals) => matchFinanceEmail(text, list)?.id ?? null;

test("by reference first — a whole word, any case — then by the customer's full name", () => {
  assert.equal(match("Re: application app-77 approved"), "f1");
  assert.equal(match("APP-778: documents outstanding"), "f2", "APP-77 is not found inside APP-778");
  assert.equal(match("Approval for DEREK  LALLYETT attached"), "f3", "the full name, spacing and case aside");
  assert.equal(match("Status update: Jody Van Heerden (our ref APP-778)"), "f2", "a reference beats a name");
});

test("never a guess: no deal, two deals, or a first name alone files nothing", () => {
  assert.equal(match("Monthly rate update"), null);
  assert.equal(match("APP-77 and APP-778 both approved"), null, "two references");
  assert.equal(match("Jody Van Heerden and Grant Smith — approved"), null, "two names");
  assert.equal(match("Jody's application", [{ id: "x", reference: null, customer: "Jody" }]), null, "a one-word name is too loose");
  assert.equal(match("ref AP", [{ id: "x", reference: "AP", customer: "A B" }]), null, "a reference too short to trust");
});

test("filed as a note on the deal, before ordinary customer routing, with nothing stored but the text", () => {
  const sync = read("src/lib/imapSync.ts");
  const route = sync.slice(sync.indexOf("export async function handleParsedMessage"));
  assert.ok(route.indexOf("fileFinanceHouseEmail(") > 0 && route.indexOf("fileFinanceHouseEmail(") < route.indexOf("return fileTimelineEmail("));
  assert.match(route, /if \(finance !== null\) return finance;/, "a finance house's email never falls through to the customer routing");
  const file = read("src/lib/financeEmail.ts");
  assert.match(file, /ciExactIds\("vendorEmail", fromEmail\)/, "the supplier whose address it IS — exact, never a pattern");
  assert.match(file, /deletedAt: null, kind: "finance"/);
  assert.match(file, /type: "note",\s*direction: null,/, "not the customer writing: no 'waiting on our reply', no contact");
  const code = file.split("\n").filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join("\n");
  assert.doesNotMatch(code, /attachment|saveFile|document\.create/i, "attachments stay in the mailbox");
  assert.match(file, /dedupeKey: email\.dedupeKey/, "idempotent on the same key as every other filed email");
  assert.match(read("src/lib/automationRegister.ts"), /An email from a finance house \(a supplier of type Finance\) is filed on the one financed deal it names/);
});
