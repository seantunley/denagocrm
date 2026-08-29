import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * Strip comments before scanning for a retired expression — the same fix
 * tests/oneAutomationEngine.test.ts documents. The notes explaining WHY the
 * contact's identity set must not choose the channel quote that very expression,
 * and a naive scan matches the explanation.
 *
 * Whole-line `//` only, so a `https://` inside a string literal survives.
 */
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const shipped = (rel: string) => stripComments(src(rel));

/**
 * A DM reply must go out on the channel the customer is actually reading, and
 * WHICH channel that is has to be a server fact.
 *
 * Two defects, one after the other:
 *
 *  1. The action derived the platform from the contact's saved identities —
 *     `contact.instagramId && !contact.messengerPsid ? "instagram" : "messenger"`.
 *     A customer who had messaged on BOTH platforms therefore always resolved to
 *     Messenger, so a reply typed into an Instagram thread was delivered over
 *     Messenger: right person, wrong channel, and staff saw "Sent ✓".
 *
 *  2. The first fix let the browser post the channel it had been rendered for.
 *     That fixed the thread but not the authority: anyone holding inbox.reply
 *     could then choose which platform a dual-identity customer was answered on,
 *     and the audit trail recorded whichever they picked as if it were the
 *     thread's own channel.
 *
 * The channel now comes from the stored Conversation and nowhere else.
 */

test("the reply channel comes from the stored conversation, not the contact's identity set", () => {
  const action = src("src/app/actions/messenger.ts");
  assert.doesNotMatch(
    shipped("src/app/actions/messenger.ts"),
    /contact\.instagramId && !contact\.messengerPsid/,
    "the contact's identity set cannot say which thread is open",
  );
  assert.match(action, /prisma\.conversation\.findFirst\(\{\s*\n?\s*where: \{ id: conversationId, contactId \}/);
  assert.match(action, /const platform: DmPlatform = conversation\.channel;/);
});

test("the conversation id is REQUIRED — there is no channel to fall back to", () => {
  const code = shipped("src/app/actions/messenger.ts");
  // The refusal has to come before anything is sent, so it is checked ahead of
  // the lookup rather than left to a null platform later.
  assert.match(code, /if \(!conversationId\) \{\s*\n?\s*return \{ error:/);
  // A posted channel is the defect this PR removes. If the action reads one
  // again, the browser is choosing the delivery route again.
  assert.doesNotMatch(code, /formData\.get\("channel"\)/, "the client must not name the channel");
  assert.doesNotMatch(code, /declaredChannel/, "and there must be no fallback to one");
});

test("a conversation belonging to another customer is refused", () => {
  const action = src("src/app/actions/messenger.ts");
  // The lookup is keyed by BOTH ids, so a conversation id from another customer
  // cannot select a channel for this one.
  const lookup = action.slice(action.indexOf("prisma.conversation.findFirst"));
  assert.match(lookup.slice(0, 200), /where: \{ id: conversationId, contactId \}/);
  assert.match(lookup, /does not belong to this customer/);
});

test("a non-DM conversation cannot be used to send a DM", () => {
  const action = src("src/app/actions/messenger.ts");
  assert.match(action, /if \(!isDmPlatform\(conversation\.channel\)\)/);
  assert.match(action, /not a Messenger or Instagram one/);
});

test("the recipient is resolved server-side from the channel, never sent by the client", () => {
  const action = src("src/app/actions/messenger.ts");
  assert.match(
    action,
    /const recipientId = platform === "instagram" \? contact\.instagramId : platform === "x" \? contact\.xUserId : contact\.messengerPsid;/,
    "the participant id must be derived from the resolved channel",
  );
  assert.doesNotMatch(action, /formData\.get\("recipientId"\)/, "a client-supplied recipient is never trusted");
});

test("a channel the contact cannot receive on fails instead of falling back", () => {
  const action = src("src/app/actions/messenger.ts");
  const guard = action.slice(action.indexOf("if (!recipientId)"), action.indexOf("let attachmentUrl"));
  // The failure must name the channel and must NOT reroute to the other one.
  assert.match(guard, /has no \$\{platform === "instagram" \? "Instagram" : platform === "x" \? "X" : "Messenger"\} identity/);
  assert.doesNotMatch(guard, /platform = "messenger"|platform = "instagram"/, "no silent cross-channel fallback");
});

test("the reply box posts the conversation and nothing else about the route", () => {
  const ui = shipped("src/components/InboxReply.tsx");
  assert.match(ui, /<input type="hidden" name="conversationId" value=\{conversationId \?\? ""\} \/>/);
  assert.doesNotMatch(ui, /name="channel"/, "posting the channel is what let the client choose it");
});

test("a DM thread with no conversation cannot be typed into or sent", () => {
  // Left enabled, the box takes a reply the action can only refuse — after the
  // person has written it. WhatsApp is excluded because its reply path addresses
  // a phone number, not a conversation.
  const ui = src("src/components/InboxReply.tsx");
  assert.match(ui, /const missingConversation = channel !== "whatsapp" && !conversationId;/);
  assert.match(ui, /<button className="btn-primary btn-sm" disabled=\{missingConversation\}>Send<\/button>/);
  assert.match(ui, /disabled=\{missingConversation\}\s*\n?\s*\/>/, "the textarea must be disabled too");
  // And it must say why, above the box, like the collision warning.
  const notice = ui.indexOf("not linked to a conversation yet");
  assert.ok(notice !== -1, "the reason must be shown");
  assert.ok(notice < ui.indexOf("<textarea"), "and shown before the box, not after");
});

/**
 * THE RESOLVER. The reply box can only carry a conversation id if something put
 * one there. `/inbox` gets it from the collaboration payload; `/messages` had no
 * conversation at all, so making the id mandatory would have disabled replying in
 * the PWA outright.
 */

test("both inbox surfaces resolve conversations from the same function", () => {
  const resolver = src("src/lib/inboxConversations.ts");
  assert.match(resolver, /export async function conversationIdsForThreads/);
  // The collaboration loader must not re-derive the join by contact + channel:
  // two derivations are how the panel and the send action came to point at
  // different conversations for one thread.
  const collab = src("src/lib/inboxCollaboration.ts");
  assert.match(collab, /conversationIdsForThreads\(threads\)/);
  assert.doesNotMatch(
    stripComments(collab),
    /channel: \{ in: channels \}/,
    "the collaboration loader must not select conversations by contact + channel of its own",
  );
  // And the PWA resolves before it renders the boxes, not when Send is pressed.
  const messages = src("src/app/messages/page.tsx");
  assert.match(messages, /await conversationIdsForThreads\(threads\)/);
  assert.match(messages, /conversations=\{conversations\}/);
});

test("only the channels that need a conversation have one created for them", () => {
  const resolver = stripComments(src("src/lib/inboxConversations.ts"));
  assert.match(resolver, /CHANNELS_REQUIRING_CONVERSATION = new Set\(\["messenger", "instagram", "x"\]\)/);
  // WhatsApp replies address a phone number the server re-reads from the contact,
  // so creating rows on sight for them would be a write with no reader.
  assert.doesNotMatch(resolver, /"whatsapp"/);
  // Creation goes through the SAME find-or-create every inbound message uses, so
  // a thread does not end up with a second conversation beside the one its
  // messages are attached to.
  assert.match(resolver, /resolveConversationId\(\{/);
});

test("the resolver and the collaboration loader agree on which conversation wins", () => {
  // A contact can have several conversations on one channel — a closed one and a
  // live one. Both sides take the newest, first-wins, or the reply box and the
  // notes panel address different threads.
  const resolver = src("src/lib/inboxConversations.ts");
  assert.match(resolver, /orderBy: \{ lastMessageAt: "desc" \}/);
  assert.match(resolver, /if \(key && !byKey\.has\(key\)\) byKey\.set\(key, conversation\.id\)/);
  // The loader now looks conversations up BY ID from that map, so there is only
  // one ordering rule left to be wrong.
  const collab = src("src/lib/inboxCollaboration.ts");
  assert.match(collab, /where: \{ id: \{ in: \[\.\.\.new Set\(idByKey\.values\(\)\)\] \} \}/);
});
