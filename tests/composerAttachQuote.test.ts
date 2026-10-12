import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { composerQuotes } from "../src/lib/composerQuotes";

const shipped = (path: string) => readFileSync(path, "utf8");

// A quote emailed from the ordinary composer (its PDF uploaded by hand) stayed a
// draft: the CRM could not tell that file from any other. The composer now
// offers the customer's quotes itself, and a quote sent that way is marked sent
// by the same rule "Email quote" uses.

const quote = (over: Partial<{ id: string; number: number; status: string; supersededAt: Date | null; deletedAt: Date | null; items: unknown[] }> = {}) => ({
  id: "q1", number: 1027, status: "draft", supersededAt: null, deletedAt: null, items: [{}], ...over,
});

test("the composer offers the customer's live, current quotes — and none to a role that can't send them", () => {
  assert.deepEqual(composerQuotes([quote()], true), [{ id: "q1", label: "Q-1027", fileName: "Quote-Q-1027.pdf", draft: true }]);
  assert.deepEqual(composerQuotes([quote({ status: "sent" })], true)[0].draft, false);
  assert.deepEqual(composerQuotes([quote()], false), []);
  assert.deepEqual(composerQuotes([quote({ supersededAt: new Date() })], true), [], "a replaced version");
  assert.deepEqual(composerQuotes([quote({ deletedAt: new Date() })], true), [], "a binned quote");
  assert.deepEqual(composerQuotes([quote({ items: [] })], true), [], "an empty quote");
  for (const status of ["declined", "cancelled"]) assert.deepEqual(composerQuotes([quote({ status })], true), [], status);
});

test("the send action checks every attached quote itself, before anything is sent", () => {
  const action = shipped("src/app/actions/emails.ts");
  const send = action.slice(action.indexOf("export async function sendEmailAction"), action.indexOf("export async function sendTestEmail"));
  const attach = send.slice(send.indexOf('formData.getAll("attachQuote")'), send.indexOf("const secure = asSecureLinks"));
  assert.ok(attach.length > 0, "the quotes are gathered before the send check and the send");
  // The permission and the quote: the pair "Email quote" requires.
  assert.match(attach, /hasPermission\(user, "quotes\.change_status"\)/);
  assert.match(attach, /canAccessQuote\(user, quoteId\)/);
  // Only a quote of the lead or customer this composer is open on.
  assert.match(attach, /\(leadId && quote\.leadId === leadId\) \|\| \(contactId && quote\.contactId === contactId\)/);
  assert.match(attach, /quote\.supersededAt/);
  assert.match(attach, /quote\._count\.items === 0/);
  // The same PDF, under the same file name; and it can go as a secure link like any other file.
  assert.match(attach, /await quotePdf\(quote\.id\)/);
  assert.match(attach, /quotePdfFileName\(quote\.number\)/);
  assert.match(attach, /if \(asSecureLinks\) secureUploads\.push/);
  // Its name is in the list the sensitive-data check reads.
  assert.match(attach, /fileNames\.push\(name\)/);
});

test("a quote is marked sent only after the email has gone, and never fails a delivered email", () => {
  const action = shipped("src/app/actions/emails.ts");
  const send = action.slice(action.indexOf("export async function sendEmailAction"), action.indexOf("export async function sendTestEmail"));
  const failed = send.indexOf("if (!result.ok) {");
  const marked = send.indexOf("await markQuoteSentIfDraft(quote)");
  assert.ok(failed > 0 && marked > failed, "marked after the send's failure has returned");
  assert.equal((send.match(/markQuoteSentIfDraft\(/g) ?? []).length, 1);
  const after = send.slice(marked - 200);
  assert.match(after, /try \{/);
  assert.match(after, /action: "quote\.emailed"/);
  assert.match(after, /if \(markedSent\) await emitQuoteJourneyEvent\("quote_sent", quote,/);
  assert.match(after, /\} catch \(err\) \{/);
});

test("both doors share one rule for marking a quote sent", () => {
  const shared = shipped("src/lib/quoteEmailSend.ts");
  assert.match(shared, /where: \{ id: quote\.id, status: "draft", updatedAt: quote\.updatedAt, deletedAt: null, signedAt: null, supersededAt: null \}/);
  assert.match(shipped("src/app/actions/quoteEmail.ts"), /markQuoteSentIfDraft\(quote\)/);
  assert.doesNotMatch(shipped("src/app/actions/emails.ts"), /status: "sent"/);
});

test("the composer shows what is attached, posts it, and warns that a draft will be marked sent", () => {
  const composer = shipped("src/components/EmailComposer.tsx");
  assert.match(composer, /name="attachQuote" value=\{q\.id\}/);
  assert.match(composer, /Attach quote \{q\.label\}/);
  assert.match(composer, /will be marked sent when this email goes/);
  // The quote's file name is in the list the send check and the secure-link option read.
  assert.match(composer, /\.\.\.pickedQuotes\.map\(\(q\) => \(\{ name: q\.fileName, sizeBytes: 0 \}\)\)/);
  for (const page of ["src/app/(app)/leads/[id]/page.tsx", "src/app/(app)/contacts/[id]/page.tsx"]) {
    assert.match(shipped(page), /quotes=\{composerQuotes\((lead|contact)\.quotes, canCancelQuotes\)\}/, page);
  }
});
