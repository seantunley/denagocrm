import assert from "node:assert/strict";
import test from "node:test";
import { replyDraft, replySubject, splitTimelineEmail, threadableMessageId, type TimelineEmail } from "../src/lib/emailReply";

const sent: TimelineEmail = {
  id: "c1",
  subject: "Your quote",
  body: "Hi Angelique,\nPlease find the quote attached.\n\n[Attachments: Q-1032 Denago Cape Town.pdf]\n[Cc: partner@example.invalid]\n[Bcc: manager@example.invalid]",
  occurredAt: "2026-10-15T10:00:00.000Z",
  direction: "outbound",
  staffName: "Thandi Mokoena",
};

test("the timeline's notes are taken off the words", () => {
  const parts = splitTimelineEmail(sent.body);
  assert.equal(parts.text, "Hi Angelique,\nPlease find the quote attached.");
  assert.equal(parts.cc, "partner@example.invalid");
  assert.equal(parts.files, "Q-1032 Denago Cape Town.pdf");
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
