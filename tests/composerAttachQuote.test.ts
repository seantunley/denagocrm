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

const sendAction = () => {
  const action = shipped("src/app/actions/emails.ts");
  return action.slice(action.indexOf("export async function sendEmailAction"), action.indexOf("export async function sendTestEmail"));
};

test("an email filed on one deal does not carry another deal's quote", () => {
  // Review of #871–#874: once the customer's page can file an email on a chosen deal,
  // attaching a DIFFERENT deal's quote would put that quotation on the wrong deal's
  // history and mark it sent from a conversation about another deal.
  const send = sendAction();
  const attach = send.slice(send.indexOf('formData.getAll("attachQuote")'), send.indexOf("const secure = asSecureLinks"));
  assert.match(attach, /if \(leadId && quote\.leadId && quote\.leadId !== leadId\) \{\s*return \{ error: `Quote Q-\$\{quote\.number\} belongs to a different deal of this customer/);
  // Refused before the PDF is rendered, so before anything can be attached, sent or marked.
  assert.ok(attach.indexOf("quote.leadId !== leadId") < attach.indexOf("await quotePdf(quote.id)"));
  // As the rule reads it: the same deal passes; a quote on no deal passes; an email on no deal passes.
  const refused = (emailDeal: string | null, quoteDeal: string | null) => Boolean(emailDeal && quoteDeal && quoteDeal !== emailDeal);
  assert.equal(refused("A", "B"), true);
  assert.equal(refused("A", "A"), false);
  assert.equal(refused("A", null), false);
  assert.equal(refused(null, "B"), false);
});

test("a quote is marked sent only after the email has gone", () => {
  const send = sendAction();
  const failed = send.indexOf("if (!result.ok) {");
  const marked = send.indexOf("markQuoteSentIfDraft(quote)");
  assert.ok(failed > 0 && marked > failed, "marked after the send's failure has returned");
  assert.equal((send.match(/markQuoteSentIfDraft\(/g) ?? []).length, 1);
  assert.match(send, /action: "quote\.emailed"/);
  assert.match(send, /if \(markedSent\) await bookkeeping\([^,]+, \(\) => emitQuoteJourneyEvent\("quote_sent", quote,/);
});

test("AFTER THE EMAIL HAS GONE NOTHING CAN FAIL THE ACTION — and one failed write does not cost the others", () => {
  // Review of #871: the quote was marked sent only after the timeline entry and
  // the audit line had both been written, so a failed audit write left a quote
  // the customer was holding marked draft — and told staff the email failed.
  const send = sendAction();
  const after = send.slice(send.indexOf("THE EMAIL HAS GONE"));
  assert.ok(after.length > 0);
  // Every write after the send goes through the one wrapper that catches and logs.
  assert.match(after, /const bookkeeping = async <T,>\(what: string, work: \(\) => Promise<T>\): Promise<T \| undefined> => \{\s*try \{\s*return await work\(\);\s*\} catch \(err\) \{/);
  const body = after.slice(after.indexOf("const emailedAt = new Date();"));
  for (const write of ["markQuoteSentIfDraft(quote)", "recordQuoteEmailed(quote, to, emailedAt)", 'action: "quote.emailed"', "recordBannerSent(bannerTenantId, bannerId)", "prisma.communication.create({", 'action: "email.sent"']) {
    const at = body.indexOf(write);
    assert.ok(at > 0, write);
    assert.match(body.slice(Math.max(0, at - 260), at), /bookkeeping\(/, `${write} is not isolated`);
  }
  // No bare await of a database write, and no error return, once the email has gone.
  assert.doesNotMatch(body, /^\s*await (prisma\.|logAudit\(|markQuoteSentIfDraft\(|recordQuoteEmailed\()/m);
  assert.doesNotMatch(body, /return \{ error:/);
  // THE QUOTE FIRST: its status and "emailed" mark are attempted before the timeline entry and the email's audit line.
  assert.ok(body.indexOf("markQuoteSentIfDraft(quote)") < body.indexOf("prisma.communication.create({"));
  assert.ok(body.indexOf("recordQuoteEmailed(quote, to, emailedAt)") < body.indexOf('action: "email.sent"'));
  // A send that could not be filed says so — and says not to send it again.
  assert.match(body, /It could not be added to the timeline — but it WAS sent\. Do not send it again\./);
});

test("the quote's own 'emailed' mark is written from the composer too — for a draft and for one already sent", () => {
  // Review of #871: #867 added Quote.emailedAt/emailedTo for the Send tab; the composer marked sent and wrote neither.
  const send = sendAction();
  // Not inside `if (markedSent)`: emailing an already-sent quote again moves the time on.
  assert.match(send, /if \(markedSent\) nowSent\.push\(quote\.number\);\s*\/\/[^\n]*\n\s*await bookkeeping\(`record Q-\$\{quote\.number\} emailed`, \(\) => recordQuoteEmailed\(quote, to, emailedAt\)\);/);
  const shared = shipped("src/lib/quoteEmailSend.ts");
  assert.match(shared, /updateMany\(\{ where: \{ id: quote\.id, tenantId: quote\.tenantId \}, data: \{ emailedAt: at, emailedTo: to \} \}\)/);
  // One writer of it, shared by both doors.
  assert.match(shipped("src/app/actions/quoteEmail.ts"), /await recordQuoteEmailed\(quote, to\.value, emailedAt\)/);
  assert.match(send, /tenantId: true,/);
});

test("THE SERVER refuses a declined or cancelled quote posted straight at it — the composer's list is not the rule", async () => {
  // Review of #871: only the browser left obsolete quotes out.
  const { COMPOSER_QUOTE_STATUSES } = await import("../src/lib/composerQuotes");
  assert.deepEqual([...COMPOSER_QUOTE_STATUSES], ["draft", "sent", "accepted"]);
  for (const status of ["declined", "cancelled", "expired", ""]) assert.equal(COMPOSER_QUOTE_STATUSES.includes(status), false, status);
  const send = sendAction();
  const attach = send.slice(send.indexOf('formData.getAll("attachQuote")'), send.indexOf("const secure = asSecureLinks"));
  assert.match(attach, /id: true, number: true, status: true,/);
  assert.match(attach, /if \(!COMPOSER_QUOTE_STATUSES\.includes\(quote\.status\)\) \{\s*return \{ error: `Quote Q-\$\{quote\.number\} is \$\{quote\.status\} — it can't be sent to the customer\. Nothing was sent\.` \};/);
  // Checked before the PDF is rendered, so before anything can be attached or sent.
  assert.ok(attach.indexOf("COMPOSER_QUOTE_STATUSES.includes(quote.status)") < attach.indexOf("await quotePdf(quote.id)"));
  // And the composer offers from the same list.
  assert.match(shipped("src/lib/composerQuotes.ts"), /COMPOSER_QUOTE_STATUSES\.includes\(q\.status\)/);
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
