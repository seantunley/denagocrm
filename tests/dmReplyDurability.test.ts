import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { staffReplyIdempotencyKey } from "../src/lib/messageDelivery";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const shipped = (rel: string) => stripComments(src(rel));

/**
 * The Messenger/Instagram reply was the last path still calling the provider
 * first and writing the CRM record afterwards — the failure #435 removed from
 * WhatsApp, left in place here because this path also uploads attachments.
 *
 * With an attachment it is worse than on WhatsApp. The file was sent, the text
 * send then failed, the person retried, and the customer received the ATTACHMENT
 * TWICE — because a retry re-ran both provider calls and neither was recognisable
 * as one that had already succeeded.
 */

test("the DM reply records and queues before it delivers", () => {
  const action = shipped("src/app/actions/messenger.ts");
  assert.doesNotMatch(action, /await sendDirectMessage\(/, "the action must not send before it records");
  assert.doesNotMatch(action, /await sendDirectAttachment\(/, "including the attachment");
  assert.match(action, /enqueueStaffMessage\(\{/);

  const enqueueAt = action.indexOf("enqueueStaffMessage({");
  const flushAt = action.indexOf("flushBotOutboxConversation(");
  assert.ok(enqueueAt >= 0 && flushAt > enqueueAt, "delivery must follow the durable record, not precede it");
});

/**
 * Meta has no single call that carries a file and its caption, so an attachment
 * and its text are two provider sends. Making them two queued messages is what
 * lets a retry after a half-succeeded submission resend only the half that
 * failed — and it matches what the customer actually receives.
 */
test("an attachment and its text are two independently deduplicated messages", () => {
  const base = {
    compositionId: "c1",
    channel: "messenger",
    key: "psid-1",
    actorId: "u1",
    contactId: "ct1",
    leadId: null,
  };
  const attachment = staffReplyIdempotencyKey({ ...base, body: "🖼 Image", attachmentUrl: "https://x/y.png" });
  const message = staffReplyIdempotencyKey({ ...base, body: "here it is", attachmentUrl: null });
  assert.notEqual(attachment, message, "the two halves must not share a key, or one silences the other");

  // Same submission repeated resolves each half to its own existing row.
  assert.equal(
    attachment,
    staffReplyIdempotencyKey({ ...base, body: "🖼 Image", attachmentUrl: "https://x/y.png" }),
  );

  // A DIFFERENT file in the same composition is a different message; otherwise
  // correcting an attachment after a failure would re-send the first one.
  assert.notEqual(
    attachment,
    staffReplyIdempotencyKey({ ...base, body: "🖼 Image", attachmentUrl: "https://x/z.png" }),
  );

  const action = shipped("src/app/actions/messenger.ts");
  // The attachment is queued FIRST, and the outbox claims a conversation's rows
  // oldest-first, so the caption can never arrive before the file it describes.
  const attachAt = action.indexOf('type: "attachment"');
  const textAt = action.indexOf('outgoing.push({ message: { type: "text", text }');
  assert.ok(attachAt >= 0 && textAt > attachAt, "the attachment must be queued before its text");
});

test("the upload happens outside the transaction, and nothing else does", () => {
  const action = shipped("src/app/actions/messenger.ts");
  const uploadAt = action.indexOf("saveFile(");
  const enqueueAt = action.indexOf("enqueueStaffMessage({");
  assert.ok(uploadAt >= 0 && enqueueAt > uploadAt, "the blob must exist before a row can point at it");
  // Its only failure mode is an orphaned blob, which the customer never sees.
  assert.doesNotMatch(action, /prisma\.communication\.create/, "history must be written by the durable path");
});

test("the DM reply reports what actually happened, worst part first", () => {
  const action = shipped("src/app/actions/messenger.ts");
  assert.doesNotMatch(action, /return \{ ok: "Sent ✓" \}/, "a blanket success is what this is removing");
  assert.match(action, /deliveryStateForMessages\(ids\)/, "the answer must come from the rows");
  assert.match(action, /sendOutcomeMessage\(states\.get\(id\)\)/);
  // An attachment that did not arrive is not made acceptable by the caption that did.
  assert.match(
    action,
    /outcomes\.find\(\(outcome\) => outcome\.error\)/,
    "with two parts the worst outcome is the answer",
  );
  assert.match(action, /queued\.outcome === "conflict"/, "and a mismatched key must be surfaced, not claimed");
});

/**
 * #433 bound the reply to the thread's channel. That must survive: resolving the
 * channel from the contact's identity set sent an Instagram reply over Messenger,
 * to a channel the customer was not looking at.
 */
test("the durable rewrite keeps the reply bound to its own thread", () => {
  const action = shipped("src/app/actions/messenger.ts");
  assert.match(action, /prisma\.conversation\.findFirst\(\{\s*where: \{ id: conversationId, contactId \}/);
  assert.doesNotMatch(
    action,
    /contact\.instagramId && !contact\.messengerPsid/,
    "the contact's identity set must not decide the channel",
  );
  // The recipient is still resolved from the resolved platform, never supplied
  // by the client, and there is still no cross-platform fallback.
  assert.match(action, /platform === "instagram" \? contact\.instagramId : contact\.messengerPsid/);
  assert.match(action, /has no \$\{platform === "instagram" \? "Instagram" : "Messenger"\} identity/);
  // And the queued row is addressed with exactly that pair.
  assert.match(action, /channel: platform,\s*\n\s*key: recipientId,/);
});

/**
 * The outbox payload is a superset of the flow's OutMsg, not a widened OutMsg. A
 * staff reply can attach a voice note, a video or a PDF; a flow can only produce
 * text, an image or a choice, and every flow node, simulator and validator would
 * otherwise have to handle a case no flow can emit.
 */
test("the queue can carry every attachment kind the DM path accepts", () => {
  const outbox = shipped("src/lib/botOutbox.ts");
  assert.match(outbox, /export type OutboxPayload = OutMsg \| \{ type: "attachment"; kind: AttachmentKind; url: string \}/);
  assert.match(outbox, /ATTACHMENT_KINDS: AttachmentKind\[\] = \["image", "audio", "video", "file"\]/);

  // Parsed defensively: a payload is JSON from the database, not a trusted value.
  const parse = outbox.slice(outbox.indexOf("function asOutMsg"), outbox.indexOf("async function sendProvider"));
  assert.match(parse, /ATTACHMENT_KINDS\.includes\(value\.kind as AttachmentKind\)/, "an unknown kind must not be sent");

  // Only Meta's DM channels have a generic attachment endpoint, and asking any
  // other channel for one is a permanent failure rather than eight retries.
  const send = outbox.slice(outbox.indexOf("async function sendProvider"), outbox.indexOf("function timelineBody"));
  assert.match(send, /row\.channel !== "messenger" && row\.channel !== "instagram"/);
  assert.match(send, /Unsupported bot channel/, "which classifies as invalid_payload, i.e. permanent");
  assert.match(send, /sendDirectAttachment\(row\.channel, row\.key, \{ type: message\.kind, url: message\.url \}\)/);

  const flow = shipped("src/lib/flow.ts");
  assert.doesNotMatch(flow, /type: "attachment"/, "the flow's vocabulary must not grow a case no flow can emit");
});
