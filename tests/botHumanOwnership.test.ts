import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { sessionAfterTurn } from "../src/lib/flowTurnState";

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
  const whatsapp = src("src/app/actions/whatsapp.ts");
  assert.match(whatsapp, /pauseBotConversation\(\{ channel: "whatsapp", key: digits \}, 12\)/);

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

  // This used to scan flowSession.ts and flowRun.ts for the ownership literals,
  // because each runner wrote the wait/handoff/end branch out by hand. They now
  // share one decision, so the property is EXECUTED against it instead — and the
  // runners are held to using it, which is what stops the two copies drifting
  // apart again (they already had, on the variables each branch stored).
  const waiting = sessionAfterTurn({ session: { nodeId: "menu", vars: {} }, handedOff: false, vars: {} });
  assert.deepEqual(
    waiting.keep ? { status: waiting.status, ownership: waiting.ownership } : null,
    { status: "active", ownership: "bot" },
    "an advancing session is still bot-owned",
  );

  const handedOff = sessionAfterTurn({ session: null, handedOff: true, vars: {} });
  assert.deepEqual(
    handedOff.keep ? { status: handedOff.status, ownership: handedOff.ownership } : null,
    { status: "paused", ownership: "ai_handoff" },
    "a bot handoff is not a takeover",
  );

  // Neither runner may mint "human" — only an explicit staff action does that.
  for (const rel of ["src/lib/flowSession.ts", "src/lib/flowRun.ts", "src/lib/flowTurnState.ts"]) {
    const code = src(rel);
    assert.match(code, /sessionAfterTurn|export function sessionAfterTurn/, `${rel}: ownership after a turn comes from the shared decision`);
    assert.doesNotMatch(code, /ownership: "human"/, `${rel}: a runner must never take a conversation on a person's behalf`);
  }
});

test("returning a conversation to automation clears stale flow state", () => {
  const control = src("src/lib/botConversationControl.ts");
  assert.match(control, /export async function resumeBotConversation/);
  assert.match(control, /deleteBotSessionTx\(tx, tenantId, identity\.channel, identity\.key\)/);

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
