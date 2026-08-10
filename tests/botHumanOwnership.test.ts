import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("manual pause preserves the live graph snapshot instead of overwriting it", () => {
  const store = src("src/lib/botSessionStore.ts");
  const pause = store.slice(store.indexOf("export async function pauseBotSessionTx"));
  assert.match(pause, /ON CONFLICT \("tenantId", "channel", "key"\) DO UPDATE/);
  assert.match(pause, /SET "status" = 'paused'/);
  assert.doesNotMatch(pause, /SET "nodeId" = EXCLUDED\."nodeId"/);
  assert.doesNotMatch(pause, /"vars" = EXCLUDED\."vars"/);
});

test("staff replies take ownership on every inbox chatbot channel", () => {
  // WhatsApp now takes ownership INSIDE the transaction that records the reply,
  // rather than as a follow-up await. That is a strengthening, not a removal: an
  // interrupted request used to be able to accept the reply and never pause the
  // bot, and the retry could not repair it because the retry recognises the
  // duplicate and stops. See staffReplyDurability.test.ts for the ordering.
  const outbox = src("src/lib/botOutbox.ts");
  const staff = outbox.slice(
    outbox.indexOf("export async function enqueueStaffMessage"),
    outbox.indexOf("async function cancelPendingBotOutputTx"),
  );
  assert.match(staff, /pauseBotSessionTx\(tx, tenantId, \{/);
  assert.match(staff, /channel: input\.channel,\s*\n\s*key: input\.key,/);

  const whatsapp = src("src/app/actions/whatsapp.ts");
  assert.match(whatsapp, /enqueueStaffMessage\(\{/, "the WhatsApp reply must go through that write");

  // Meta DMs still pause explicitly: that path has not been moved onto the
  // durable queue yet, so its ownership step is still its own await.
  const meta = src("src/app/actions/messenger.ts");
  assert.match(meta, /pauseBotConversation\(\{ channel: platform, key: recipientId \}, 12\)/);
});

test("flow-mode WhatsApp ownership is the BotSession, not a second timestamp heuristic", () => {
  const run = src("src/lib/flowRun.ts");
  // Ownership is read from the session and interpreted by one shared rule. It used
  // to be `status === "paused"`, which could not distinguish a bot handoff from a
  // staff takeover — so a greeting evicted the person holding the conversation.
  assert.match(run, /decideInboundAct\(/);
  assert.match(run, /ownership: existing \? existing\.ownership : null/);
  assert.doesNotMatch(run, /botShouldPause\(/, "flow mode must not override an explicit Return to bot with a stale human-message timestamp");
});

test("staff takeover and bot handoff are recorded as different things", () => {
  const control = src("src/lib/botConversationControl.ts");
  assert.match(control, /ownership: "human"/, "a person taking the thread must be recorded as such");

  for (const rel of ["src/lib/flowSession.ts", "src/lib/flowRun.ts"]) {
    const code = src(rel);
    assert.match(code, /ownership: "ai_handoff"/, `${rel}: a bot handoff is not a takeover`);
    assert.match(code, /ownership: "bot"/, `${rel}: an advancing session is still bot-owned`);
  }
});

test("returning a conversation to automation clears stale flow state", () => {
  const control = src("src/lib/botConversationControl.ts");
  assert.match(control, /export async function resumeBotConversation/);
  // Staff release uses the UNGUARDED variant deliberately: the runtime's
  // deleteBotSessionTx now refuses human-owned rows so an in-flight turn cannot
  // take the thread back, and a person handing it back must still be able to.
  assert.match(control, /releaseBotSessionTx\(tx, tenantId, identity\.channel, identity\.key\)/);

  const action = src("src/app/actions/conversations.ts");
  assert.match(action, /mode === "human" \? "conversation\.bot_paused" : "conversation\.bot_resumed"/);
  assert.match(action, /requireConversationAccess\(conversationId, "inbox\.reply"\)/);
});

test("the inbox renders explicit Take over and Return to bot controls", () => {
  const ui = src("src/components/ConversationCollab.tsx");
  assert.match(ui, /Human handling/);
  assert.match(ui, /Bot available/);
  assert.match(ui, /Return to bot/);
  assert.match(ui, /Take over/);
  assert.match(ui, /setConversationBotMode/);
});

test("inbox collaboration derives bot ownership in one server-side batch", () => {
  const loader = src("src/lib/inboxCollaboration.ts");
  assert.match(loader, /basePrisma\.botSession\.findMany/);
  assert.match(loader, /status: "paused"/);
  assert.match(loader, /expiresAt: \{ gt: new Date\(\) \}/);
  assert.match(loader, /botIdentityForRecord/);
});
