import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_MONEY_CENTS, parseMoneyInput } from "../src/lib/moneyInput";

/*
 * Review of #924: parseRands() read "1000,50" as R100 050,00. Money received is
 * typed the South African way as often as not, so the payment and deposit forms
 * read amounts strictly — both everyday formats, and a refusal for anything that
 * would otherwise be guessed.
 */

const cents = (raw: string) => {
  const result = parseMoneyInput(raw);
  assert.ok(result.ok, `expected "${raw}" to parse, got: ${result.ok ? "" : result.error}`);
  return result.cents;
};
const refused = (raw: string) => {
  const result = parseMoneyInput(raw);
  assert.equal(result.ok, false, `expected "${raw}" to be refused, got ${result.ok ? result.cents : ""}`);
};

test("the four cases from the review are all R1 000,50", () => {
  assert.equal(cents("1000.50"), 100_050);
  assert.equal(cents("1,000.50"), 100_050);
  assert.equal(cents("1000,50"), 100_050);
  assert.equal(cents("1 000,50"), 100_050);
});

test("comma decimals: one or two cents digits", () => {
  assert.equal(cents("1,5"), 150);
  assert.equal(cents("0,99"), 99);
  assert.equal(cents("250 000,00"), 25_000_000);
});

test("thousands separators: spaces (any kind) or commas", () => {
  assert.equal(cents("1 000"), 100_000);
  assert.equal(cents("1 000 000.25"), 100_000_025);
  assert.equal(cents("1 000,50"), 100_050, "non-breaking space");
  assert.equal(cents("1 000,50"), 100_050, "narrow no-break space (Intl en-ZA)");
  assert.equal(cents("1,000"), 100_000);
  assert.equal(cents("12,345,678.90"), 1_234_567_890);
});

test("a leading currency marker is ignored", () => {
  assert.equal(cents("R1000"), 100_000);
  assert.equal(cents("R 1 000,50"), 100_050);
  assert.equal(cents("ZAR 250,00"), 25_000);
  assert.equal(cents("  r500  "), 50_000);
});

test("plain whole and dotted amounts", () => {
  assert.equal(cents("0"), 0);
  assert.equal(cents("007"), 700);
  assert.equal(cents("1000.5"), 100_050);
  assert.equal(cents("205000"), 20_500_000);
});

test("ambiguous or malformed amounts are refused, never guessed", () => {
  for (const raw of [
    "1.000", //        European thousands — 1 or 1 000?
    "1.000,50", //     European thousands + comma decimal
    "1.000.000",
    "1,000,50", //     comma used for both
    "12,34,567", //    mis-grouped
    "1 00", //         space that isn't a thousands group
    "1  000",
    "1000.505", //     three decimal places
    "1000,", "1000.", ",50", ".50",
    "-500", "+500", "5e3", "abc", "", "   ", "R",
    "1 000,50 R",
  ]) refused(raw);
});

test("refusals tell the person how to type it", () => {
  const result = parseMoneyInput("1.000,50");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /1 000,50 or 1000\.50/);
});

test("amounts beyond the INTEGER cents column are refused", () => {
  assert.equal(cents("21 474 836,47"), MAX_MONEY_CENTS);
  refused("21 474 836,48");
  refused("99999999999999999999");
});
