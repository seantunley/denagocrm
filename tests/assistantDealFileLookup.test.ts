import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { assistantStep, dealFileArgs, suppliersArgs } from "../src/lib/crmAssistantPlan";

const src = readFileSync(new URL("../src/lib/assistantDealFileLookup.ts", import.meta.url), "utf8");

test("deal_file and suppliers are lookups DAX can ask for", () => {
  assert.equal(assistantStep.safeParse({ tool: "deal_file", args: { deal: "Q-1031" } }).success, true);
  assert.equal(assistantStep.safeParse({ tool: "deal_file", args: {} }).success, false, "a deal is required");
  assert.equal(dealFileArgs.safeParse({ deal: "Oak", userId: "x" }).success, false, "strict");
  assert.equal(suppliersArgs.safeParse({ supplier: "Denago", missing: true, orders: true }).success, true);
  assert.equal(assistantStep.safeParse({ tool: "suppliers", args: {} }).success, true);
});

test("deal_file is held to the deal page's rule and reads through its loader", () => {
  assert.match(src, /hasAnyPermission\(user, "quotes\.view_all", "quotes\.view_owned"\)/);
  assert.match(src, /const quoteIds = await getAccessibleQuoteIds\(user\);/);
  // The access filter is ANDed, never replaced by what was asked for.
  assert.match(src, /AND: \[\s*\.\.\.\(quoteIds === null \? \[\] : \[\{ id: \{ in: quoteIds \} \}\]\),/);
  assert.match(src, /where: \{\s*tenantId,\s*deletedAt: null,/);
  assert.match(src, /await loadDealFile\(\{ id: quote\.id, leadId: quote\.leadId \}, user\)/);
  // EVERY matching quote, not the newest 20 (review of #1104); more than 6 deals: the count, never a partial list.
  assert.match(src, /take: DEAL_MATCH_CEILING \+ 1,\s*select: \{ id: true, leadId: true, number: true, createdAt: true \},/);
  assert.match(src, /if \(deals\.size > DEAL_CANDIDATES\) \{\s*return unavailable\(`\$\{deals\.size\} deals match/);
  assert.doesNotMatch(src, /take: 20/);
  // With Suppliers off, no supplier is named.
  assert.match(src, /\.\.\.\(file\.suppliersOn\s*\?/);
});

test("suppliers is the owner's, behind the Suppliers module, with the digest's own 'missing' rule and no bank details", () => {
  assert.match(src, /if \(!\(await isModuleEnabled\("suppliers"\)\)\)/);
  assert.match(src, /if \(!\(await isWorkspaceOwner\(user, tenantId\)\)\)/);
  assert.match(src, /where: \{ tenantId, deletedAt: null, /);
  assert.match(src, /await missingSupplierPapers\(tenantId\)\)\s*\.filter\(\(d\) => open === null \|\| open\.includes/);
  // The fields read: never the payment reference (nor registration/VAT numbers, which no question needs).
  assert.match(src, /id: true, name: true, kind: true, phone: true, email: true, paymentTerms: true,/);
  assert.doesNotMatch(src, /paymentReference: true|vatNumber: true|registrationNumber: true/);
  assert.doesNotMatch(src, /logError|console\./, "nothing here is logged");
});
