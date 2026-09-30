import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

/**
 * Q-1022 (2026-09-29): a quote made from a lead with no customer could never
 * get one. The editor locked the customer box for any lead quote, the save
 * refused any customer on a lead quote, and linking the lead afterwards didn't
 * reach the quote. Each half is pinned here.
 */
const editor = readFileSync("src/components/quotes/QuoteEditorDialog.tsx", "utf8");
const quotes = readFileSync("src/app/actions/quotes.ts", "utf8");
const leads = readFileSync("src/app/actions/leads.ts", "utf8");

test("the editor locks a lead quote's customer only once it has one", () => {
  assert.match(editor, /disabled=\{!editable \|\| Boolean\(record\?\.leadLabel && record\?\.contactId\)\}/);
});

test("the save refuses CHANGING a lead quote's customer, not filling a missing one", () => {
  assert.match(quotes, /existing\.leadId && existing\.contactId && existing\.contactId !== data\.contactId/);
  assert.match(quotes, /tx\.lead\.updateMany\(\{\s*where: \{ id: existing\.leadId, contactId: null/);
});

test("linking a lead's customer fills it in on that lead's customerless draft quotes", () => {
  const link = leads.slice(leads.indexOf("export async function linkLeadToContact"), leads.indexOf("export async function convertLeadToContact"));
  assert.match(link, /quote\.updateMany\(\{\s*where: \{ leadId, contactId: null, status: "draft", deletedAt: null \}/);
});
