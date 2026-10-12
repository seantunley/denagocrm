import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import {
  ASSISTANT_WHATSAPP_HANDOFF_KEY,
  ASSISTANT_WHATSAPP_HANDOFF_TO_KEY,
  HANDOFF_CHAT_CHARS,
  HANDOFF_CHAT_MESSAGES,
  HANDOFF_SEND_WAIT_MS,
  PROACTIVE_SOURCES,
  handoffRecipient,
  handoffText,
  updateText,
  whatsappHandoffOn,
} from "../src/lib/assistantWhatsAppRules";

/*
 * THE CHATBOT HANDS A CUSTOMER TO A PERSON, ON THAT PERSON'S OWN WHATSAPP.
 * Sean, 2026-10-12: "a configurable/optional handoff with the chat to my number
 * with customer details, so I can chat to them. The handoff must be logged in
 * the CRM." The claims that matter:
 *   - OFF until an owner switches it on; the push the team already gets is unchanged;
 *   - it carries who the customer is, how to reach them, what they want, the
 *     chat so far, and a link that opens a WhatsApp chat with them;
 *   - it goes to the ONE person chosen, or to everyone — and only ever to a
 *     phone that person linked and verified themselves;
 *   - it is LOGGED on the customer's record, with who it went to;
 *   - it cannot hold up, or break, the bot's reply to the customer.
 * Run against fakes: no database, no WhatsApp.
 */

const code = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

type Scope = { tenantId: string | null; system: boolean } | undefined;
type Link = { tenantId: string; userId: string; verifiedAt: Date | null; waId: string | null; updatesOnWhatsApp: boolean };
const state = {
  scope: { tenantId: "t1", system: false } as Scope,
  handoffSwitch: "on" as string | null,
  handoffTo: null as string | null,
  whatsappOn: true,
  links: [] as Link[],
  members: new Set<string>(),
  inbox: new Set<string>(),
  contacts: new Map<string, { firstName: string; lastName: string | null; phone: string | null; email: string | null }>(),
  leads: new Map<string, { name: string; phone: string | null; email: string | null }>(),
  pushes: [] as { title: string; body: string; url?: string; kind?: string }[],
  turns: [] as { tenantId: string; userId: string; question: string; answer: string; source: string }[],
  audits: [] as { action: string; summary: string; contactId?: string | null; leadId?: string | null; userName?: string }[],
  sends: [] as { tenantId: string; userId: string }[],
  sendTakesMs: 0,
  prepTakesMs: 0,
  /** How many statements wrote handoff records. */
  turnWrites: 0,
  sendThrows: false,
  pushThrows: false,
  errors: [] as string[],
};

type Loader = (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only") return {};
  if ((parent?.filename ?? "").replace(/\\/g, "/").endsWith("src/lib/handoffNotify.ts")) {
    switch (request) {
      case "./db": return {
        basePrisma: {
          assistantPhoneLink: { findMany: async ({ where }: { where: { tenantId: string; userId?: string } }) =>
            state.links
              .filter((l) => l.tenantId === where.tenantId && l.verifiedAt && l.waId && l.updatesOnWhatsApp && (where.userId === undefined || l.userId === where.userId))
              .map((l) => ({ userId: l.userId })) },
          assistantTurn: { createMany: async ({ data }: { data: (typeof state.turns)[number][] }) => {
            state.turnWrites += 1;
            state.turns.push(...data);
            return { count: data.length };
          } },
        },
        // The workspace-scoped client: a record in another workspace reads as missing.
        prisma: {
          contact: { findUnique: async ({ where }: { where: { id: string } }) => state.contacts.get(where.id) ?? null },
          lead: { findUnique: async ({ where }: { where: { id: string } }) => {
            // A slow database, while the notice is still being PREPARED.
            if (state.prepTakesMs) await new Promise((resolve) => setTimeout(resolve, state.prepTakesMs));
            return state.leads.get(where.id) ?? null;
          } },
        },
      };
      case "./settings": return { getSetting: async (key: string) => (key === ASSISTANT_WHATSAPP_HANDOFF_KEY ? state.handoffSwitch : key === ASSISTANT_WHATSAPP_HANDOFF_TO_KEY ? state.handoffTo : null) };
      case "./audit": return { logAudit: async (entry: (typeof state.audits)[number]) => { state.audits.push(entry); } };
      case "./errorLog": return { logError: async (...args: unknown[]) => { state.errors.push(args.map(String).join(" ")); } };
      case "./push": return { sendPushToAll: async (payload: { title: string; body: string; url?: string }, kind?: string) => {
        if (state.pushThrows) throw new Error("push service down");
        state.pushes.push({ ...payload, kind });
        return 1;
      } };
      case "./tenantScope": return { currentTenantScope: () => state.scope };
      case "./tenantOrigin": return { tenantOrigin: async () => "https://crm.example.test" };
      case "./permissions": return { hasAnyPermission: async (user: { id: string }, ...perms: string[]) => {
        assert.deepEqual(perms, ["inbox.view", "inbox.reply"]);
        return state.inbox.has(user.id);
      } };
      case "./assistantUser": return { assistantUserFor: async (id: string) => (state.members.has(id) ? { id, name: `Name of ${id}`, email: `${id}@x`, role: "staff" } : null) };
      case "./assistantWhatsApp": return {
        assistantWhatsAppOn: async () => state.whatsappOn,
        sendUpdatesToLinkedPhone: async (tenantId: string, userId: string) => {
          if (state.sendThrows) throw new Error("whatsapp down");
          if (state.sendTakesMs) await new Promise((resolve) => setTimeout(resolve, state.sendTakesMs));
          state.sends.push({ tenantId, userId });
          return "sent";
        },
      };
    }
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const require_ = createRequire(import.meta.url);
const { notifyHandoff } = require_("../src/lib/handoffNotify.ts") as typeof import("../src/lib/handoffNotify");

const link = (userId: string, over: Partial<Link> = {}) => {
  state.links.push({ tenantId: "t1", userId, verifiedAt: new Date(), waId: `2782000${state.links.length}`, updatesOnWhatsApp: true, ...over });
  state.members.add(userId);
  state.inbox.add(userId);
};
const HANDOFF = {
  channel: "WhatsApp",
  body: "Wants a price on the Rover XL · asked for a person",
  url: "/leads/l1",
  customer: { contactId: null, leadId: "l1", waDigits: "27821234567" },
  answers: { name: "Anna", model: "Rover XL" },
  chat: () => [
    { role: "user" as const, content: "Hi, how much is the Rover XL?" },
    { role: "assistant" as const, content: "Let me get one of the team to help you with that." },
  ],
};

beforeEach(() => {
  state.scope = { tenantId: "t1", system: false };
  state.handoffSwitch = "on";
  state.handoffTo = null;
  state.whatsappOn = true;
  state.links = [];
  state.members = new Set();
  state.inbox = new Set();
  state.contacts = new Map();
  state.leads = new Map([["l1", { name: "Anna Smith", phone: "082 123 4567", email: "anna@example.test" }]]);
  state.pushes = [];
  state.turns = [];
  state.audits = [];
  state.sends = [];
  state.sendTakesMs = 0;
  state.prepTakesMs = 0;
  state.turnWrites = 0;
  state.sendThrows = false;
  state.pushThrows = false;
  state.errors = [];
});

test("OFF unless the switch says exactly on — and with it off the push still goes, nothing is sent to a phone and nothing is logged", async () => {
  for (const [raw, on] of [[null, false], ["", false], ["off", false], ["ON", false], ["true", false], ["on", true]] as const) assert.equal(whatsappHandoffOn(raw), on, String(raw));
  link("u1");
  state.handoffSwitch = null;
  await notifyHandoff(HANDOFF);
  assert.deepEqual(state.pushes, [{ title: "WhatsApp needs you 🙋", body: HANDOFF.body, url: "/leads/l1", kind: "bot_handoff" }], "the notification the team already gets is unchanged");
  assert.deepEqual(state.turns, []);
  assert.deepEqual(state.sends, []);
  assert.deepEqual(state.audits, []);
});

test("what the person receives: who the customer is, how to reach them, what they want, the chat so far, and a link to chat to them", async () => {
  link("sean");
  await notifyHandoff(HANDOFF);
  assert.equal(state.turns.length, 1);
  const turn = state.turns[0];
  assert.equal(turn.source, "handoff");
  assert.equal(turn.tenantId, "t1");
  assert.equal(turn.question, "WhatsApp chat handed to you");
  assert.equal(turn.answer, [
    "Anna Smith\nPhone: 082 123 4567\nEmail: anna@example.test",
    "What they need: Wants a price on the Rover XL · asked for a person",
    "Their answers:\nname: Anna\nmodel: Rover XL",
    "The chat so far:\nCustomer: Hi, how much is the Rover XL?\nChatbot: Let me get one of the team to help you with that.",
    "Chat to them on WhatsApp: https://wa.me/27821234567\nTheir record in the CRM: https://crm.example.test/leads/l1",
  ].join("\n\n"));
  // As it arrives on the phone.
  assert.ok(updateText(turn).startsWith("🙋 WhatsApp chat handed to you\n\nAnna Smith\n"));
  assert.ok((PROACTIVE_SOURCES as readonly string[]).includes("handoff"), "so the same delivery, retry and 24-hour rules apply as for a briefing");
  assert.deepEqual(state.sends, [{ tenantId: "t1", userId: "sean" }]);
  assert.equal(state.pushes.length, 1, "and the push still goes");
});

test("the message, by its parts: a customer the CRM does not know yet, no number, long and many messages, answers that should not be forwarded", () => {
  const base = { summary: "", customer: { name: null, phone: null, email: null }, answers: {}, chat: [], waDigits: null, crmUrl: "https://crm.example.test/inbox" };
  // Messenger, nobody on record: it says so, and points at the inbox instead of a WhatsApp link.
  assert.equal(handoffText(base), "Name not given\n\nNo WhatsApp number on record — reply from the CRM inbox.\nTheir record in the CRM: https://crm.example.test/inbox");
  // Only the last few messages, each cut to a readable length, and blanks dropped.
  const chat = [
    ...Array.from({ length: 12 }, (_, i) => ({ from: "customer" as const, text: `message ${i + 1}` })),
    { from: "bot" as const, text: "   " },
    { from: "bot" as const, text: "x".repeat(HANDOFF_CHAT_CHARS + 50) },
  ];
  const lines = handoffText({ ...base, chat }).split("The chat so far:\n")[1].split("\n\n")[0].split("\n");
  assert.equal(lines.length, HANDOFF_CHAT_MESSAGES);
  assert.equal(lines[0], "Customer: message 6", "the oldest are left out, not the newest");
  assert.equal(lines.at(-1)!.length, "Chatbot: ".length + HANDOFF_CHAT_CHARS);
  assert.ok(lines.at(-1)!.endsWith("…"));
  // An answer is shown only under a plain variable name, and only when it is short.
  const answers = handoffText({ ...base, answers: { name: "Anna", preferred_model: "Rover XL", "__internal": "x", "weird key!": "y", essay: "z".repeat(201), empty: "  " } });
  assert.match(answers, /Their answers:\nname: Anna\npreferred model: Rover XL\n\n/);
  assert.doesNotMatch(answers, /internal|weird|essay|empty/);
});

test("on WhatsApp the number they wrote from is how to reach them, even when the record has none — and a customer record is used when there is one", async () => {
  link("sean");
  state.leads.set("l1", { name: "Anna Smith", phone: null, email: null });
  await notifyHandoff(HANDOFF);
  assert.match(state.turns[0].answer, /^Anna Smith\nPhone: \+27821234567\n\n/);
  state.turns = [];
  state.contacts.set("c1", { firstName: "Anna", lastName: "Smith", phone: "082 999 0000", email: null });
  await notifyHandoff({ ...HANDOFF, url: "/contacts/c1", customer: { contactId: "c1", leadId: "l1", waDigits: "27821234567" } });
  assert.match(state.turns[0].answer, /^Anna Smith\nPhone: 082 999 0000\n\n/);
  // A chat that cannot be read costs the transcript, not the handoff.
  state.turns = [];
  await notifyHandoff({ ...HANDOFF, chat: () => { throw new Error("database down"); } });
  assert.equal(state.turns.length, 1);
  assert.doesNotMatch(state.turns[0].answer, /The chat so far/);
});

test("WHO it goes to: the one person chosen, or everyone — and if the chosen person has no linked phone, nobody (it never falls back to somebody else)", async () => {
  for (const [raw, id] of [[null, null], ["", null], ["all", null], ["user_1", "user_1"], ["has spaces", null], ["x".repeat(65), null]] as const) assert.equal(handoffRecipient(raw), id, String(raw));
  link("sean");
  link("donovan");
  await notifyHandoff(HANDOFF);
  assert.deepEqual(state.turns.map((t) => t.userId), ["sean", "donovan"], "everyone, by default");

  state.turns = [];
  state.sends = [];
  state.handoffTo = "sean";
  await notifyHandoff(HANDOFF);
  assert.deepEqual(state.turns.map((t) => t.userId), ["sean"]);
  assert.deepEqual(state.sends.map((s) => s.userId), ["sean"]);

  state.turns = [];
  state.audits = [];
  state.handoffTo = "someone-who-unlinked";
  await notifyHandoff(HANDOFF);
  assert.deepEqual(state.turns, [], "the customer's details go to nobody rather than to somebody who was not chosen");
  assert.deepEqual(state.audits, []);
});

test("who is NEVER sent a customer's details: an unverified or unlinked phone, someone who switched their updates off, a former member, someone without the inbox, another workspace", async () => {
  link("ok");
  link("unverified", { verifiedAt: null });
  link("no-number", { waId: null });
  link("updates-off", { updatesOnWhatsApp: false });
  link("left");
  state.members.delete("left");
  link("no-inbox");
  state.inbox.delete("no-inbox");
  link("elsewhere", { tenantId: "t2" });
  await notifyHandoff(HANDOFF);
  assert.deepEqual(state.turns.map((t) => t.userId), ["ok"]);
  assert.deepEqual(state.sends.map((s) => s.userId), ["ok"]);
  // The same holds for the ONE chosen person: choosing them does not waive any of it.
  for (const chosen of ["unverified", "no-number", "updates-off", "left", "no-inbox", "elsewhere"]) {
    state.turns = [];
    state.handoffTo = chosen;
    await notifyHandoff(HANDOFF);
    assert.deepEqual(state.turns, [], chosen);
  }
});

test("LOGGED IN THE CRM: on the customer's own record, saying who it went to — and never what the customer said", async () => {
  link("sean");
  link("donovan");
  await notifyHandoff(HANDOFF);
  assert.equal(state.audits.length, 1);
  const entry = state.audits[0];
  assert.equal(entry.action, "bot.handoff_to_whatsapp");
  assert.equal(entry.leadId, "l1");
  assert.equal(entry.userName, "Chatbot");
  assert.equal(entry.summary, "Chatbot handed this WhatsApp conversation to Name of sean, Name of donovan on WhatsApp, with the customer's details and the chat so far");
  assert.doesNotMatch(entry.summary, /Rover|price|Anna|082|2782/, "names of staff only");
  // Logged BEFORE any sending starts, so a slow WhatsApp cannot leave a handoff unrecorded.
  const lib = code("src/lib/handoffNotify.ts");
  assert.ok(lib.indexOf('action: "bot.handoff_to_whatsapp"') < lib.indexOf("sendUpdatesToLinkedPhone(tenantId, person.id)"));
});

test("THE DEADLINE COVERS PREPARING THE NOTICE, not only sending it: a slow database cannot hold the customer's reply", async () => {
  // Review of #865: only the final send was bounded. Reading the customer and
  // the chat, checking recipients and writing the records were awaited without limit.
  link("u1");
  state.prepTakesMs = HANDOFF_SEND_WAIT_MS + 1500;
  const started = Date.now();
  await notifyHandoff(HANDOFF);
  const waited = Date.now() - started;
  assert.ok(waited < HANDOFF_SEND_WAIT_MS + 1000, `returned after ${waited} ms, not after the slow read`);
  assert.equal(state.pushes.length, 1, "the push went first, as always");
  // Not cancelled: the notice finishes on its own once the database answers.
  assert.equal(state.turns.length, 0, "still preparing when the bot's turn moved on");
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(state.turns.length, 1, "and it was still written and sent");
  assert.deepEqual(state.sends, [{ tenantId: "t1", userId: "u1" }]);
  assert.equal(state.audits.length, 1);

  const lib = code("src/lib/handoffNotify.ts");
  // One race, around the whole of it; none left inside.
  assert.equal((lib.match(/Promise\.race\(/g) ?? []).length, 1);
  assert.match(lib, /const work = tellLinkedPhones\(handoff\)\.catch\(/);
  assert.match(lib, /await Promise\.race\(\[work, new Promise\(\(resolve\) => \{ timer = setTimeout\(resolve, HANDOFF_SEND_WAIT_MS\); \}\)\]\);/);
  // And the platform is asked to let it finish after the response.
  assert.match(lib, /const \{ after \} = await import\("next\/server"\);\s*after\(\(\) => work\);/);
});

test("many recipients cost one write, not one each — and their checks run together", async () => {
  for (let i = 0; i < 12; i += 1) link(`u${i}`);
  await notifyHandoff(HANDOFF);
  assert.equal(state.turns.length, 12);
  assert.equal(state.turnWrites, 1);
  assert.equal(state.sends.length, 12);
  const lib = code("src/lib/handoffNotify.ts");
  assert.doesNotMatch(lib, /for \(const \{ userId \} of links\)/, "no query-per-recipient loop");
  assert.match(lib, /await basePrisma\.assistantTurn\.createMany\(/);
});

test("A REFUSED SAVE CHANGES NOTHING: the recipient and the template are checked before any switch is saved", () => {
  // Review of #865: the handoff switch was saved, THEN the recipient was validated —
  // an unlinked choice left handoffs on, going to whoever the old setting named.
  const actions = code("src/app/actions/assistantSettings.ts");
  const card = actions.slice(actions.indexOf("export async function saveAssistantWhatsAppCard"));
  const firstSave = Math.min(card.indexOf("await saveAssistantWhatsApp(formData)"), card.indexOf("putSetting("));
  const preCheck = card.indexOf("await checkWhatsAppCard(formData);");
  assert.ok(preCheck > 0 && preCheck < firstSave, "checked before the WhatsApp switch and before every setting");
  assert.match(card, /if \(checked\.error\) return checked;\s*const whatsapp = await saveAssistantWhatsApp\(formData\);/);
  // The check itself writes nothing.
  const check = actions.slice(actions.indexOf("async function checkWhatsAppCard"), actions.indexOf("export async function saveAssistantWhatsAppCard"));
  assert.doesNotMatch(check, /putSetting|logAudit|\.create\(|\.update|\.delete/);
  // A value that is not an id is refused by name, never read as "everyone".
  assert.match(check, /if \(rawRecipient && rawRecipient !== "all" && !wanted\) \{\s*refuse\("That isn't a team member/);
  assert.equal(handoffRecipient("someone; DROP"), null);
  assert.equal(handoffRecipient("all"), null);
  assert.equal(handoffRecipient(""), null);
  // When turning it on for one person, WHO is saved before the switch: never on with the old recipient.
  assert.ok(card.indexOf("await putSetting(ASSISTANT_WHATSAPP_HANDOFF_TO_KEY, to);") < card.indexOf("await putSetting(ASSISTANT_WHATSAPP_HANDOFF_KEY,"));
});

test("no real workspace, or WhatsApp for staff switched off: the push goes and nothing else happens", async () => {
  link("u1");
  for (const arrange of [
    () => { state.scope = undefined; },
    () => { state.scope = { tenantId: null, system: false }; },
    () => { state.scope = { tenantId: "t1", system: true }; },
    () => { state.whatsappOn = false; },
  ]) {
    state.scope = { tenantId: "t1", system: false };
    state.whatsappOn = true;
    state.pushes = [];
    arrange();
    await notifyHandoff(HANDOFF);
    assert.equal(state.pushes.length, 1);
    assert.deepEqual(state.turns, []);
    assert.deepEqual(state.sends, []);
    assert.deepEqual(state.audits, []);
  }
});

test("it never holds up or breaks the bot's reply to the customer", async () => {
  link("u1");
  // A slow WhatsApp: the bot's turn waits a moment, then carries on; the handoff is saved and finishes on its own.
  state.sendTakesMs = HANDOFF_SEND_WAIT_MS + 1500;
  const started = Date.now();
  await notifyHandoff(HANDOFF);
  const waited = Date.now() - started;
  assert.ok(waited < HANDOFF_SEND_WAIT_MS + 1000, `returned after ${waited} ms, not after the slow send`);
  assert.equal(state.turns.length, 1, "saved before any sending starts, so the half-hourly sweep can send it");
  assert.equal(HANDOFF_SEND_WAIT_MS <= 5000, true);
  // Everything failing at once: it still resolves.
  state.sendTakesMs = 0;
  state.sendThrows = true;
  state.pushThrows = true;
  await notifyHandoff(HANDOFF);
});

test("every handoff goes through the one door, with the customer and the chat — and that door cannot message a customer", () => {
  const flowRun = code("src/lib/flowRun.ts");
  assert.match(flowRun, /handoff: async \(vars, context\) => \{\s*await notifyHandoff\(\{\s*channel: "WhatsApp",[\s\S]*?customer: \{ contactId: match\.contactId, leadId: match\.leadId, waDigits: digits \},\s*answers: vars,\s*chat: \(\) => whatsappHistory\(match\.contactId, match\.leadId, digits\),/);
  assert.match(code("src/lib/flowDm.ts"), /await notifyHandoff\(\{ channel: platform === "instagram" \? "Instagram" : "Messenger", body: handoffBody\(context\), url: "\/inbox", customer: \{ contactId: contact\?\.id \?\? null, leadId: null \}, answers: vars, chat: \(\) => state\.msgs \}\);/);
  assert.match(code("src/lib/telegram.ts"), /await notifyHandoff\(\{ channel: "Telegram", body: handoffBody\(context\), url: "\/inbox", customer: \{ contactId: contact\?\.id \?\? null, leadId: null \}, answers: vars, chat: \(\) => state\.msgs \}\);/);
  assert.match(code("src/lib/bot.ts"), /await notifyHandoff\(\{\s*channel: "WhatsApp",[\s\S]*?customer: \{ contactId, leadId, waDigits: fromDigits \},/);
  for (const file of ["src/lib/flowRun.ts", "src/lib/flowDm.ts", "src/lib/telegram.ts", "src/lib/bot.ts"]) {
    assert.doesNotMatch(code(file), /needs you 🙋/, `${file}: the push is sent from the one door only`);
  }
  const lib = code("src/lib/handoffNotify.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // It writes an assistant turn and asks for it to be delivered to STAFF. It cannot message a customer.
  assert.doesNotMatch(lib, /sendWhatsApp(Text|Buttons|Template)|sendEmail|sendMessenger|sendTelegram|communication\.create/);
  // The customer is read through the workspace-scoped client; the link names its workspace and must be verified.
  assert.match(lib, /await prisma\.contact\.findUnique\(/);
  assert.match(lib, /where: \{ tenantId, verifiedAt: \{ not: null \}, waId: \{ not: null \}, updatesOnWhatsApp: true, \.\.\.\(only \? \{ userId: only \} : \{\}\) \}/);
  assert.match(lib, /told\.map\(\(person\) => \(\{ tenantId, userId: person\.id, question: `\$\{handoff\.channel\} chat handed to you`, answer, source: "handoff" \}\)\)/);
});

test("the settings: the owner's, audited, off by default, the recipient checked against real links, described where it is switched, and on the Automatic jobs page", () => {
  const actions = code("src/app/actions/assistantSettings.ts");
  const card = actions.slice(actions.indexOf("export async function saveAssistantWhatsAppCard"));
  assert.match(card, /const user = await requireTenantOwner\(\);[\s\S]*const handoff = formData\.get\("whatsappHandoff"\) === "on";\s*if \(handoff !== whatsappHandoffOn\(await getSetting\(ASSISTANT_WHATSAPP_HANDOFF_KEY\)\)\) \{\s*await putSetting\(ASSISTANT_WHATSAPP_HANDOFF_KEY, handoff \? "on" : "off"\);\s*await logAudit\(/);
  // The recipient is not whatever the form sent: it must be a verified link in THIS workspace.
  assert.match(actions, /findFirst\(\{ where: \{ tenantId, userId: wanted, verifiedAt: \{ not: null \}, waId: \{ not: null \} \}, select: \{ userId: true \} \}\)/);
  assert.match(actions, /if \(wanted && !linked\) refuse\("That person has no linked WhatsApp/);
  assert.match(card, /await putSetting\(ASSISTANT_WHATSAPP_HANDOFF_TO_KEY, to\);\s*await logAudit\(/);
  const page = code("src/app/(app)/settings/assistant/page.tsx");
  assert.match(page, /<input type="checkbox" name="whatsappHandoff" defaultChecked=\{handoffOn\}/);
  assert.match(page, /<select name="whatsappHandoffTo" defaultValue=\{handoffTo \?\? "all"\}/);
  // Said where it is switched: it logs the handoff, not the conversation that follows on another number.
  assert.match(page, /the CRM logs the handoff, not the conversation after\s+it/);
  assert.match(page, /It only goes to a phone that person linked themselves/);
  const register = code("src/lib/automationRegister.ts");
  assert.match(register, /key: "chatbot-handoff-notice",[\s\S]*?reaches: "staff",\s*channels: \["push", "whatsapp"\],/);
  // And a handoff is a kind of unprompted answer everywhere those are counted or marked seen.
  assert.match(code("src/app/(app)/layout.tsx"), /source: \{ in: \[\.\.\.PROACTIVE_SOURCES\] \}, seenAt: null/);
  assert.match(code("src/lib/assistantScheduleRun.ts"), /where: \{ userId, source: \{ in: \[\.\.\.PROACTIVE_SOURCES\] \}, seenAt: null \},/);
  assert.match(code("src/components/AssistantChat.tsx"), /turn\.source === "handoff" \?/);
});
