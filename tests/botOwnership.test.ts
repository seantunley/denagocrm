import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { decideInboundAct } from "../src/lib/botOwnership";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const act = (ownership: Parameters<typeof decideInboundAct>[0]["ownership"], text: string, hasChoiceId = false) =>
  decideInboundAct({ ownership, text, hasChoiceId }).act;

test("a staff-owned conversation cannot be taken back by anything the customer types", () => {
  // The actual sequence that broke: customer asks for a human, a salesperson
  // starts replying, customer says "hi", and the bot restarted the flow on top
  // of the person.
  for (const text of ["hi", "hello", "hey", "menu", "restart", "start over", "anything at all"]) {
    assert.equal(act("human", text), "suppress", `"${text}" must not wake the bot on a human-owned conversation`);
  }
});

test("a bot handoff is escaped only by an explicit command, never by a greeting", () => {
  for (const greeting of ["hi", "hello", "hey", "hi there", "Hey!"]) {
    assert.equal(act("ai_handoff", greeting), "suppress", `"${greeting}" is a greeting, not a control command`);
  }
  for (const command of ["menu", "restart", "start over", "start again", "MENU"]) {
    assert.equal(act("ai_handoff", command), "restart", `"${command}" must return the customer to the bot`);
  }
});

test("a tapped button never escapes a handoff", () => {
  // Option ids are attacker-free but they are also not a request to restart —
  // a stale keyboard from before the handoff must not resurrect the bot.
  assert.equal(act("ai_handoff", "", true), "suppress");
  assert.equal(act("ai_handoff", "menu", true), "suppress");
});

test("after a message definitively failed to send, the next one starts over", () => {
  // The customer never saw the prompt. Resuming would interpret their reply
  // against a menu that does not exist for them.
  assert.equal(act("delivery_failed", "I need some help"), "restart");
  assert.equal(act("delivery_failed", "Rover XL"), "restart");
  assert.equal(act("delivery_failed", "", true), "restart", "even a stale button must not resume the dead node");
});

test("a conversation the bot still owns behaves exactly as before", () => {
  // Deliberately unchanged: nobody else is holding it, so "hi" meaning "take me
  // back to the top" is harmless.
  for (const text of ["hi", "hello", "hey", "menu", "start", "begin", "restart"]) {
    assert.equal(act("bot", text), "restart", `"${text}" restarts a bot-owned conversation, as it always did`);
  }
  assert.equal(act("bot", "the blue one"), "resume");
  assert.equal(act("bot", "Rover XL", true), "resume", "a tapped option is answered, not treated as a command");
});

test("no session at all is a fresh run", () => {
  assert.equal(act(null, "hi"), "restart");
  assert.equal(act(null, "I want a service booking"), "restart");
});

test("ownership gates every route into the bot, not just the flow runner", () => {
  // The hole an adversarial review found in the first version of this fix:
  // runWhatsAppBot sends voice notes — and everything, when BOT_FLOW_ENABLED is
  // off — to maybeAutoReply, which never reads BotSession. Its only brake is a
  // timestamp heuristic over the last outbound Communication, and Take over
  // writes no Communication, so the AI answered over the salesperson.
  const run = src("src/lib/flowRun.ts");
  const entry = run.slice(run.indexOf("export async function runWhatsAppBot"));
  const gate = entry.indexOf("decideInboundAct(");
  const voice = entry.indexOf("maybeAutoReply(digits, input.text, { voiceNote: true })");
  const flow = entry.indexOf("runWhatsAppFlow(digits, input, opts.entryContext)");
  assert.ok(gate >= 0, "the entry point must consult ownership");
  assert.ok(gate < voice, "the voice-note path must be gated");
  assert.ok(gate < flow, "and so must the flow path");
});

test("an in-flight bot turn cannot take a conversation back from staff", () => {
  // A turn runs for seconds (aiReply is a live model call). Staff can press Take
  // over during it. Without a guard the turn commits afterwards and silently
  // returns the thread to the bot, with the takeover already audited.
  const store = src("src/lib/botSessionStore.ts");
  const upsert = store.slice(store.indexOf("export async function upsertBotSessionTx"));
  assert.match(upsert.slice(0, upsert.indexOf("\n}")), /WHERE "BotSession"\."ownership" <> 'human'/);

  const del = store.slice(store.indexOf("export async function deleteBotSessionTx"));
  assert.match(del.slice(0, del.indexOf("\n}")), /ownership: \{ not: "human" \}/);

  // …but a PERSON handing the thread back must still be able to clear it.
  const release = store.slice(store.indexOf("export async function releaseBotSessionTx"));
  const body = release.slice(0, release.indexOf("\n}"));
  assert.doesNotMatch(body, /ownership/, "staff release is the one path allowed to discard human ownership");
  assert.match(src("src/lib/botConversationControl.ts"), /releaseBotSessionTx\(/);
});

test("the runtime asks this module rather than testing status directly", () => {
  // The defect was `existing?.status === "paused" && !restart`, which cannot tell
  // a bot handoff from a human takeover. If that shape comes back, so does the bug.
  const code = src("src/lib/flowSession.ts");
  assert.match(code, /decideInboundAct\(/, "advanceFlow must use the ownership decision");
  assert.doesNotMatch(
    code,
    /status === "paused" && !restart/,
    "suppression must not be decided by status alone — that is what conflated handoff with takeover",
  );
});

test("the inbox distinguishes a staff takeover from a bot handoff", () => {
  // Both write status "paused", so deriving the badge from status labelled a bot
  // handoff "Human handling" — staff left it alone believing a colleague had it
  // while the customer waited. Nearly the opposite of the truth: a handoff is
  // exactly the case that needs a person.
  const loader = src("src/lib/inboxCollaboration.ts");
  assert.match(loader, /ownership: true/, "the loader must select the ownership column");
  assert.match(loader, /session\.ownership === "human"/, "only a staff takeover is 'human handling'");
});

test("the simulator can reach the booking template's happy path", () => {
  // The template gates on booking_identity == "verified"; the stub never set it,
  // so the starter always fell to its security branch and an operator testing it
  // concluded the template was broken.
  const stub = src("src/lib/flowSimulatorScenario.ts");
  assert.match(stub, /bookingIdentity: "verified"/);
  // And the variable must be discoverable to anyone hand-building a flow.
  assert.match(src("src/components/FlowBuilder.tsx"), /booking_identity/);
});

test("the flow editor renders one AI draft panel, not two", () => {
  const page = src("src/app/(app)/bot-builder/[id]/page.tsx");
  const renders = page.match(/<FlowAiDraftForm\b/g) ?? [];
  assert.equal(renders.length, 1, `expected exactly one AI draft panel, found ${renders.length}`);
});
