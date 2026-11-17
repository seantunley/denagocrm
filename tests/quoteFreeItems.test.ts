import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseActionList, quoteBuildText } from "../src/lib/assistantActions";
import { parseTaskUpdate } from "../src/lib/assistantTaskRules";
import { splitFreeFees } from "../src/lib/quoteFreeItems";

/*
 * Donovan, 2026-11-17: "quote a Rover XL, R5 000 delivery, and mention the free dust cover". DAX put the cover on as
 * a R0 fee, every check refused a R0 fee, and the Confirm failed ("problem with its fees.1.amount"). A free item is
 * now proposed as a R0 fee and SAVED as a R0 line — the quote editor drops a R0 fee on its next save, a line it keeps.
 */

const LEAD = "cmabcdefghijklmnopqrstuv";
const PRODUCT = "cmproductabcdefghijklmno";

test("a free item can be proposed — on a quote, on an addition, and on its job sheet", () => {
  const fees = [{ label: "Delivery — Mount Edgecombe", amount: 5000, delivery: true }, { label: "Dust cover (free)", amount: 0 }];
  assert.equal(parseActionList([{ type: "quote_build", leadId: LEAD, lines: [{ productId: PRODUCT, qty: 1 }], fees }]).length, 1);
  assert.equal(parseActionList([{ type: "quote_add", quote: "Q-1047", fees }]).length, 1);
  assert.deepEqual(parseTaskUpdate({ kind: "quote", fees })?.fees?.map((fee) => fee.amount), [5000, 0]);
  // Still no credits.
  assert.equal(parseActionList([{ type: "quote_add", quote: "Q-1047", fees: [{ label: "Discount", amount: -1 }] }]).length, 0);
});

test("the card says it is included free, and the save makes it a R0 line, not a fee", () => {
  const text = quoteBuildText([], (c) => `R${c / 100}`, { fees: [{ label: "Dust cover", amountCents: 0, delivery: false }] });
  assert.match(text, /Included free: Dust cover — a line at R0/);
  assert.deepEqual(splitFreeFees([{ label: " Dust cover ", amountCents: 0 }, { label: "Delivery", amountCents: 500_000 }]), {
    fees: [{ label: "Delivery", amountCents: 500_000 }],
    free: [{ description: "Dust cover", qty: 1, unitPriceCents: 0 }],
  });
  // Both Confirms save through it, and accept a zero.
  const action = readFileSync(new URL("../src/app/actions/assistant.ts", import.meta.url), "utf8");
  assert.match(action, /\}\), \.\.\.builtFees\.free\],/);
  assert.match(action, /\}\), \.\.\.added\.free\],\s*fees: added\.fees\.map\(/);
  assert.doesNotMatch(action, /fee\.amountCents <= 0/);
});
