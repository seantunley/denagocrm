import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { referralPrefix } from "../src/lib/referralPrefix";

test("Denago's referral codes stay DGO; another workspace's start with its own name", () => {
  assert.equal(referralPrefix("tenant_denago_cpt", "Denago Cape Town"), "DGO");
  assert.equal(referralPrefix(null, null), "DGO", "no workspace known: the founding one's");
  assert.equal(referralPrefix("t2", "Acme Golf Carts"), "ACM");
  assert.equal(referralPrefix("t2", "4x4 Co"), "XCO", "digits and spaces are skipped");
  assert.equal(referralPrefix("t2", "AB"), "REF");
});

test("the lead form asks about a product, and colour only where the catalogue uses colours", () => {
  const form = readFileSync("src/components/LeadForm.tsx", "utf8");
  assert.doesNotMatch(form, /Vehicle interest|Model undecided|DGO-XXXX/);
  assert.match(form, /title="Product interest"/);
  assert.match(form, /const usesColours = products\.some\(\(item\) => item\.colors\.length > 0\) \|\| Boolean\(defaults\.color\)/);
  assert.match(form, /const colourField = usesColours && \(\s*<Field label="Colour preference"/);
});
