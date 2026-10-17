import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * Opening a customer is not permission to read their quotations (review of #891).
 * The customer page loads `contact.quotes` once, and the sidebar's latest quote
 * (number, status, value), the Documents tab's quote groups and the email
 * composer's quote buttons are all built from it — so it is narrowed at the
 * query to the quotes the viewer may open.
 */
const page = readFileSync("src/app/(app)/contacts/[id]/page.tsx", "utf8");

test("the customer's quotes are narrowed to the viewer's at the query", () => {
  assert.match(page, /const quoteIds = \(await hasPermission\(user, "quotes\.view_all"\)\) \? null : await getAccessibleQuoteIds\(user\);/);
  assert.match(page, /quotes: \{\s*where: \{ deletedAt: null, \.\.\.\(quoteIds \? \{ id: \{ in: quoteIds \} \} : \{\}\) \},/);
  // The narrowing happens BEFORE the customer is loaded, not as a filter some readers remember to apply.
  assert.ok(page.indexOf("const quoteIds =") < page.indexOf("prisma.contact.findUnique({"));
});

test("every place on the page that shows a quote reads the narrowed list", () => {
  // The sidebar, the Documents tab (and the files filed against a quote), and the composer's quote buttons.
  assert.match(page, /Latest quote<\/p><TabLink tab="documents"[^>]*>Q-\{contact\.quotes\[0\]\.number\}/);
  assert.match(page, /where: \{ quoteId: \{ in: contact\.quotes\.map\(\(quote\) => quote\.id\) \}, deletedAt: null \}/);
  assert.match(page, /const quoteGroups = contact\.quotes\.map\(/);
  assert.match(page, /quotes=\{composerQuotes\(contact\.quotes,/);
  // A file filed against a quote never comes in through the customer's own documents instead.
  assert.match(page, /const looseDocuments = contact\.documents\.filter\(\(document\) => document\.quoteId == null\);/);
  // No second, unnarrowed read of the customer's quotes.
  assert.doesNotMatch(page, /prisma\.quote\.find(Many|First)\(\{\s*where: \{ contactId/);
});
