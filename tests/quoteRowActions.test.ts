import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const src = (rel: string) => readFileSync(rel, "utf8");

test("Download PDF is the attached file, gated like the print page", () => {
  const route = src("src/app/(print)/quotes/[id]/pdf/route.ts");
  assert.match(route, /return withActingStaffScope\(async \(\) => \{/, "binds the workspace before reading permissions");
  assert.match(route, /await requireQuoteReadAccess\(id\);/);
  assert.ok(route.indexOf("requireQuoteReadAccess(id)") < route.indexOf("quotePdf(id)"), "no document before the gate");
  assert.match(route, /quotePdf\(id\)/, "the same renderer the quote email attaches");
  assert.match(route, /"Content-Disposition": `attachment; filename="Q-\$\{quote\.number\}\.pdf"; filename\*=UTF-8''\$\{encodeURIComponent\(fileName\)\}`/);
  assert.match(route, /const fileName = quotePdfFileName\(quote\.number, company\.name\);/, "named like every other quote PDF");
  assert.match(route, /"Cache-Control": "private, no-store"/);
});

test("a sent or accepted quote's row offers Send and PDF; the rest sits under More", () => {
  const row = src("src/components/quotes/QuoteRowActions.tsx");
  assert.match(row, /export const SEND_FROM_ROW = new Set\(\["sent", "accepted"\]\);/);
  assert.match(row, /\{common && canSend && <QuoteEmailDialog compact quoteId=\{quoteId\}/, "Send only for who may send (quotes.change_status)");
  assert.match(row, /\{common && \(\s*<a href=\{`\/quotes\/\$\{quoteId\}\/pdf`\} download/);
  const more = row.slice(row.indexOf("<PopoverContent"), row.indexOf("</PopoverContent>"));
  for (const label of ["Duplicate", 'trigger="Cancel quote"', 'trigger="Delete quote"']) assert.ok(more.includes(label), `${label} is under More`);

  const page = src("src/app/(app)/quotes/page.tsx");
  assert.equal((page.match(/canSend=\{canCancel\}/g) ?? []).length, 2, "mobile and desktop rows");
  assert.equal((page.match(/deleteAction=\{deleteQuote\.bind\(null, quote\.id\)\} canDelete=\{canDelete\}/g) ?? []).length, 2);
  assert.doesNotMatch(page, /<ConfirmDelete/, "Delete is no longer its own link on the row");
});

test("Send on a row is the same email dialog: nothing goes until Send is clicked in it", () => {
  const dialog = src("src/components/quotes/QuoteEmailDialog.tsx");
  assert.match(dialog, /onClick=\{openDialog\}/);
  assert.match(dialog, /\{compact \? "Send" : alreadyEmailed \? "Email again" : "Email quote"\}/);
});

test("a quote can be created from the board card's menu, with the lead's product on it", () => {
  const board = src("src/components/KanbanBoard.tsx");
  assert.match(board, /<Item disabled=\{!permissions\.canCreateQuote\} onSelect=\{actions\.quote\}>/);
  assert.match(board, /const result = await createQuoteFromLead\(lead\.id\);/);
  assert.match(board, /if \(result\?\.redirectTo\) router\.push\(result\.redirectTo\);/, "opens in the editor");
  assert.match(src("src/app/(app)/leads/page.tsx"), /hasPermission\(currentUser, "quotes\.create"\)/);
  // The seed is the lead's own product (the same path as the lead page's "Create quote").
  assert.match(src("src/lib/quoteFromLead.ts"), /productId: lead\.product\.id/);
});
