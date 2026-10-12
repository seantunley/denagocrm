import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const shipped = (path: string) => readFileSync(path, "utf8");

// Sending from "Email quote" closed the pop-up and left the Send tab exactly as
// it was: nothing said the email had gone, and "Save & mark sent" was still on
// offer. The quote now carries when and to whom it was emailed, and the tab
// says so the moment the send returns.

test("a sent quote email is recorded on the quote, after the send and never instead of it", () => {
  const action = shipped("src/app/actions/quoteEmail.ts");
  const send = action.slice(action.indexOf("export async function sendQuoteEmail"));
  const delivered = send.indexOf("if (!result.ok) return result;");
  // Written by the one function both doors share (the composer's "Attach quote" is the other).
  const recorded = send.indexOf("await recordQuoteEmailed(quote, to.value, emailedAt)");
  assert.ok(delivered > 0 && recorded > delivered, "recorded only once the email has gone");
  // The row is named by its workspace as well as its id.
  assert.match(shipped("src/lib/quoteEmailSend.ts"), /updateMany\(\{ where: \{ id: quote\.id, tenantId: quote\.tenantId \}, data: \{ emailedAt: at, emailedTo: to \} \}\)/);
  // A failure to record must not report a delivered email as failed.
  assert.match(send.slice(recorded, recorded + 200), /\.catch\(/);
  assert.match(send, /to: to\.value,\s+emailedAt: emailedAt\.toISOString\(\),\s+markedSent: result\.markedSent,/);
  // Opening the dialog records nothing.
  const draft = action.slice(action.indexOf("export async function quoteEmailDraft"), action.indexOf("export async function sendQuoteEmail"));
  assert.doesNotMatch(draft, /emailedAt/);
});

test("the schema and migration carry the two columns, additively", () => {
  const schema = shipped("prisma/schema.prisma");
  const quote = schema.slice(schema.indexOf("model Quote {"));
  const model = quote.slice(0, quote.indexOf("\n}"));
  assert.match(model, /emailedAt\s+DateTime\?/);
  assert.match(model, /emailedTo\s+String\?/);
  const sql = shipped("prisma/migrations/20261012130000_quote_emailed/migration.sql");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "emailedAt" TIMESTAMP\(3\);/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "emailedTo" TEXT;/);
  assert.doesNotMatch(sql, /DROP|NOT NULL|UPDATE /i);
});

test("the Send tab says the quote was emailed, at once and on every later open", () => {
  const view = shipped("src/app/actions/recordSigning.ts");
  assert.match(view, /emailed: quote\.emailedAt && quote\.emailedTo \? \{ at: quote\.emailedAt, to: quote\.emailedTo \} : null/);

  const dialog = shipped("src/components/quotes/QuoteEmailDialog.tsx");
  assert.match(dialog, /onSent\?\.\(\{ to: result\.to, emailedAt: result\.emailedAt, markedSent: result\.markedSent \}\)/);
  assert.match(dialog, /alreadyEmailed \? "Email again" : "Email quote"/);

  const editor = shipped("src/components/quotes/QuoteEditorDialog.tsx");
  // At once: from what the send returned, not from a refetch that may lag.
  assert.match(editor, /setJustEmailed\(\{ quoteId: savedQuote\.id, at: sent\.emailedAt, to: sent\.to \}\)/);
  assert.match(editor, /if \(sent\.markedSent\) setSavedQuote\(/);
  // Only for the quote it was sent for: a revision is a new, un-emailed quote.
  assert.match(editor, /justEmailed && justEmailed\.quoteId === signingQuoteId/);
  // Later opens: from the quote itself.
  assert.match(editor, /: signing\?\.emailed \?\? null/);
  assert.match(editor, /data-testid="quote-emailed"/);
  assert.match(editor, /alreadyEmailed=\{Boolean\(emailed\)\}/);
});

test("a revision or a copy does not inherit the old version's emailed mark", () => {
  for (const file of ["src/app/actions/quotes.ts", "src/lib/quoteOutcome.ts"]) {
    assert.doesNotMatch(shipped(file), /emailedAt|emailedTo/, file);
  }
});
