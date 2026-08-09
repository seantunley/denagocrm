import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * Strip comments before scanning for the retired expression — the same fix
 * tests/oneAutomationEngine.test.ts documents. The note explaining WHY the
 * contact's identity set must not choose the channel quotes that very
 * expression, and a naive scan matches the explanation.
 *
 * Whole-line `//` only, so a `https://` inside a string literal survives.
 */
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const shipped = (rel: string) => stripComments(src(rel));

/**
 * A DM reply must go out on the channel the staff member was replying IN.
 *
 * The action used to re-derive the platform from the contact's saved identities:
 *
 *   contact.instagramId && !contact.messengerPsid ? "instagram" : "messenger"
 *
 * A customer who had messaged on BOTH platforms therefore always resolved to
 * Messenger, so a reply typed into an Instagram thread was delivered over
 * Messenger — to the right person, on a channel they were not looking at, while
 * staff saw "Sent ✓".
 */

test("the reply channel comes from the thread, not the contact's identity set", () => {
  const action = src("src/app/actions/messenger.ts");
  assert.doesNotMatch(
    shipped("src/app/actions/messenger.ts"),
    /contact\.instagramId && !contact\.messengerPsid/,
    "the contact's identity set cannot say which thread is open",
  );
  // The Conversation is the authority when one exists.
  assert.match(action, /prisma\.conversation\.findFirst\(\{\s*\n?\s*where: \{ id: conversationId, contactId \}/);
  assert.match(action, /platform = conversation\.channel;/);
});

test("a conversation belonging to another customer is refused", () => {
  const action = src("src/app/actions/messenger.ts");
  // The lookup is keyed by BOTH ids, so a conversation id from another customer
  // cannot select a channel for this one.
  const lookup = action.slice(action.indexOf("prisma.conversation.findFirst"));
  assert.match(lookup.slice(0, 200), /where: \{ id: conversationId, contactId \}/);
  assert.match(lookup, /does not belong to this customer/);
});

test("the recipient is resolved server-side from the channel, never sent by the client", () => {
  const action = src("src/app/actions/messenger.ts");
  assert.match(
    action,
    /const recipientId = platform === "instagram" \? contact\.instagramId : contact\.messengerPsid;/,
    "the participant id must be derived from the resolved channel",
  );
  assert.doesNotMatch(action, /formData\.get\("recipientId"\)/, "a client-supplied recipient is never trusted");
});

test("a channel the contact cannot receive on fails instead of falling back", () => {
  const action = src("src/app/actions/messenger.ts");
  const guard = action.slice(action.indexOf("if (!recipientId)"), action.indexOf("let attachmentUrl"));
  // The failure must name the channel and must NOT reroute to the other one.
  assert.match(guard, /has no \$\{platform === "instagram" \? "Instagram" : "Messenger"\} identity/);
  assert.doesNotMatch(guard, /platform = "messenger"|platform = "instagram"/, "no silent cross-channel fallback");
});

test("the reply box states which channel it was rendered for", () => {
  const ui = src("src/components/InboxReply.tsx");
  assert.match(ui, /<input type="hidden" name="channel" value=\{channel\} \/>/);
  assert.match(ui, /name="conversationId"/);
});
