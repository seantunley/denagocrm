import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  newReplyMessageId,
  replyDeliveryNote,
  replyEmailRecipient,
  replyOutcomeText,
  replyThreadHeaders,
} from "../src/lib/helpdeskReplyEmail";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("reply threads onto the customer's email: In-Reply-To = latest, References = chain", () => {
  const headers = replyThreadHeaders(["msg:<first@cust.com>", null, "imap:acct:INBOX:1:7", "msg:<ours@shop.co.za>", "msg:<second@cust.com>"]);
  assert.deepEqual(headers, {
    "In-Reply-To": "<second@cust.com>",
    References: "<first@cust.com> <ours@shop.co.za> <second@cust.com>",
  });
});

test("no email ids on the case → no threading headers (staff-opened ticket)", () => {
  assert.equal(replyThreadHeaders([]), undefined);
  assert.equal(replyThreadHeaders(["imap:acct:INBOX:1:7", null]), undefined);
});

test("an inbound Message-ID carrying CR/LF or spaces is dropped, not echoed into our headers", () => {
  const headers = replyThreadHeaders(["msg:<ok@cust.com>", "msg:<evil@x.com>\r\nBcc: victim@x.com", "msg:<a b@x.com>"]);
  assert.equal(headers?.["In-Reply-To"], "<ok@cust.com>");
  assert.equal(headers?.References, "<ok@cust.com>");
});

test("a long chain keeps the thread root plus the most recent ids", () => {
  const ids = Array.from({ length: 15 }, (_, i) => `msg:<m${i}@x.com>`);
  const refs = replyThreadHeaders(ids)!.References.split(" ");
  assert.equal(refs.length, 10);
  assert.equal(refs[0], "<m0@x.com>");
  assert.equal(refs[9], "<m14@x.com>");
});

test("our Message-ID is on the mailbox's domain", () => {
  assert.equal(newReplyMessageId("abc", "Support@Shop.co.za"), "<abc@shop.co.za>");
  assert.equal(newReplyMessageId("abc", null), "<abc@helpdesk.local>");
});

test("who gets emailed", () => {
  assert.deepEqual(replyEmailRecipient({ source: "email", contactEmail: "a@b.com", mailboxEmail: null }), { to: "a@b.com" });
  assert.deepEqual(replyEmailRecipient({ source: "portal", contactEmail: "a@b.com", mailboxEmail: "help@shop.com" }), { to: "a@b.com" });
  assert.deepEqual(replyEmailRecipient({ source: "portal", contactEmail: "a@b.com", mailboxEmail: null }), { skip: "no_mailbox" });
  assert.deepEqual(replyEmailRecipient({ source: "email", contactEmail: "  ", mailboxEmail: "help@shop.com" }), { skip: "no_email" });
});

test("the agent is told what actually happened", () => {
  assert.equal(replyOutcomeText({ status: "sent", to: "a@b.com", messageId: "<x@y>" }), "Emailed to a@b.com");
  assert.equal(replyOutcomeText({ status: "skipped", reason: "no_email" }), "Posted to portal only — no email on file");
  assert.match(replyOutcomeText({ status: "skipped", reason: "no_mailbox" }), /^Posted to portal only — /);
  assert.match(replyOutcomeText({ status: "failed", to: "a@b.com", error: "SMTP is not configured" }), /email to a@b\.com FAILED: SMTP is not configured/);
});

test("the ticket thread labels each reply from its stored outcome", () => {
  assert.deepEqual(replyDeliveryNote({ email: { status: "sent", to: "a@b.com", messageId: "<x@y>" } }), { text: "Emailed to a@b.com", failed: false });
  assert.equal(replyDeliveryNote({ email: { status: "failed", to: "a@b.com", error: "x" } })?.failed, true);
  assert.equal(replyDeliveryNote(null), null, "replies from before this change carry no outcome");
});

test("the reply action emails AFTER the commit and reports the outcome instead of 'Reply sent'", () => {
  const action = src("src/app/actions/helpdesk.ts");
  const reply = action.slice(action.indexOf("export async function replyToTicket"), action.indexOf("// ── Internal note"));
  assert.ok(reply.indexOf("emailTicketReply(") > reply.indexOf("withActingTenantWrite("), "email only once the reply is committed");
  assert.match(reply, /return \{ success: replyOutcomeText\(emailed\) \}/);
  assert.match(action, /messageId,\s*headers: threading/);
  assert.match(action, /sourceMessageId: `msg:\$\{outcome\.messageId\}`/, "our Message-ID threads the customer's answer back");
  // Customer timeline via the shared outbound log, not a hand-written row.
  assert.match(action, /record: \{ contactId: item\.contactId, userId, label: `Help desk reply C-\$\{item\.number\}` \}/);
  assert.doesNotMatch(action, /communication\.create\(/);
  assert.doesNotMatch(src("src/components/helpdesk/TicketComposer.tsx"), /success="Reply sent"/);
});
