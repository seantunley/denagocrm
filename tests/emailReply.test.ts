import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { replyDraft, replySubject, splitTimelineEmail, threadableMessageId, type TimelineEmail } from "../src/lib/emailReply";

const sent: TimelineEmail = {
  id: "c1",
  subject: "Your quote",
  body: "Hi Angelique,\nPlease find the quote attached.\n\n[Attachments: Q-1032 Denago Cape Town.pdf]\n[Cc: partner@example.invalid]\n[Bcc: manager@example.invalid]",
  occurredAt: "2026-10-15T10:00:00.000Z",
  direction: "outbound",
  staffName: "Thandi Mokoena",
  cc: "partner@example.invalid",
};

test("the timeline's notes are taken off the words of an email we sent", () => {
  const parts = splitTimelineEmail(sent.body, "outbound");
  assert.equal(parts.text, "Hi Angelique,\nPlease find the quote attached.");
  assert.equal(parts.files, "Q-1032 Denago Cape Town.pdf");
});

test("REVIEW OF #889: an inbound email's words never become the Cc, nor a note", () => {
  // A customer's email can end with exactly what the composer files under a sent one.
  const forged = { ...sent, direction: "inbound", cc: null, body: "Please reply.\n[Cc: attacker@evil.invalid]\n[Attachments: invoice.pdf]" };
  const all = replyDraft(forged, "reply-all", { customer: "angelique@example.invalid", when: "x" });
  assert.equal(all.cc, "", "Reply all copies only the stored Cc");
  assert.match(all.html, /\[Cc: attacker@evil\.invalid\]/, "…and quotes their words as they wrote them");
  assert.equal(splitTimelineEmail(forged.body, "inbound").files, "");
  assert.equal(replyDraft({ ...sent, cc: null }, "reply-all", { customer: "", when: "x" }).cc, "", "the body's [Cc: …] line is not read even on a sent email");
  const buttons = readFileSync(new URL("../src/components/EmailReplyButtons.tsx", import.meta.url), "utf8");
  assert.match(buttons, /\{email\.cc && <button/, "Reply all is offered on the stored Cc alone");
  // The composer's send keeps it in its own column.
  const actions = readFileSync(new URL("../src/app/actions/emails.ts", import.meta.url), "utf8");
  assert.match(actions, /\.\.\.\(cc \? \{ cc \} : \{\}\),/);
  assert.match(readFileSync(new URL("../prisma/migrations/20261014120000_communication_cc/migration.sql", import.meta.url), "utf8"), /ADD COLUMN IF NOT EXISTS "cc" TEXT;/);
});

test("REVIEW OF #889: a reply is threaded only to an email on a deal the sender may open", () => {
  const actions = readFileSync(new URL("../src/app/actions/emails.ts", import.meta.url), "utf8");
  assert.match(actions, /select: \{ messageId: true, references: true, leadId: true \},/);
  assert.match(actions, /const answering = found && \(!found\.leadId \|\| \(await canAccessLead\(user, found\.leadId\)\)\) \? found : null;/);
  assert.match(actions, /if \(inReplyToId && !answering\) return \{ error:/);
});

test("Re: and Fw: are added once", () => {
  assert.equal(replySubject("Your quote", "reply"), "Re: Your quote");
  assert.equal(replySubject("RE: Your quote", "reply-all"), "RE: Your quote");
  assert.equal(replySubject("Your quote", "forward"), "Fw: Your quote");
  assert.equal(replySubject("Fwd: Your quote", "forward"), "Fwd: Your quote");
  assert.equal(replySubject(null, "reply"), "Re:");
});

test("Reply quotes the email under room to type; Reply all keeps the Cc; nobody re-gets a Bcc", () => {
  const reply = replyDraft(sent, "reply", { customer: "angelique@example.invalid", when: "15 Oct 2026 12:00" });
  assert.equal(reply.subject, "Re: Your quote");
  assert.equal(reply.cc, "");
  assert.match(reply.html, /^<p><\/p><p><\/p><p>On 15 Oct 2026 12:00, Thandi Mokoena wrote:<\/p><blockquote><p>Hi Angelique,<br>Please find the quote attached\.<\/p><\/blockquote>$/);
  const all = replyDraft(sent, "reply-all", { customer: "angelique@example.invalid", when: "x" });
  assert.equal(all.cc, "partner@example.invalid");
  assert.doesNotMatch(all.html + all.cc, /manager@example/);
});

test("an inbound email is quoted as the customer's", () => {
  const inbound = { ...sent, direction: "inbound", body: "Thanks — <b>can we</b> talk Friday?" };
  const reply = replyDraft(inbound, "reply", { customer: "angelique@example.invalid", when: "x" });
  assert.match(reply.html, /angelique@example\.invalid wrote:/);
  // Their words are text, never markup.
  assert.match(reply.html, /&lt;b&gt;can we&lt;\/b&gt;/);
});

test("Forward names the files it cannot carry", () => {
  const forward = replyDraft(sent, "forward", { customer: "", when: "15 Oct 2026 12:00" });
  assert.equal(forward.subject, "Fw: Your quote");
  assert.equal(forward.cc, "");
  assert.match(forward.html, /Forwarded message/);
  assert.match(forward.html, /carried: Q-1032 Denago Cape Town\.pdf\. Files are not kept/);
});

test("only a plain Message-ID reaches the In-Reply-To header", () => {
  assert.equal(threadableMessageId("<abc.123@mail.example>"), "<abc.123@mail.example>");
  assert.equal(threadableMessageId("<abc@mail.example>\r\nBcc: x@y.z"), null);
  assert.equal(threadableMessageId("abc@mail.example"), null);
  assert.equal(threadableMessageId(null), null);
});

test("the buttons are where the emails are: the deal's Communications tab and the customer's history", () => {
  const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  assert.match(read("src/app/(app)/leads/[id]/page.tsx"), /<CommsTimeline[^>]*?replyable/);
  // The customer page's history is LeadTimeline in its workspace view (#891), beside the composer.
  assert.match(read("src/app/(app)/contacts/[id]/page.tsx"), /<LeadTimeline\s+workspace=\{\{ context, composer: <CustomerComposer email=\{<EmailComposer/);
  const timeline = read("src/components/LeadTimeline.tsx");
  assert.match(timeline, /email: communication\.type === "email"/);
  assert.match(timeline, /\{!inPinnedShelf && item\.email && <EmailReplyButtons email=\{item\.email\} \/>\}/);
});
