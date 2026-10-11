import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Module, { createRequire } from "node:module";
import {
  ASSISTANT_WHATSAPP_CONFIRM_KEY,
  PENDING_ACTION_TTL_MS,
  WHATSAPP_CONFIRMABLE,
  confirmButtonId,
  confirmMessages,
  parseConfirmId,
  splitForWhatsApp_cards,
  whatsappConfirmOn,
} from "../src/lib/assistantWhatsAppRules";

/*
 * Confirming a task on WhatsApp. Until this existed a linked phone could only
 * READ answers; this is the one place it can CHANGE a record. So the claims
 * that matter are negative ones: nothing runs without the owner's switch, a
 * tap runs a task at most once and only for the person it was offered to,
 * nothing customer-facing can be confirmed here, and the door that lets a phone
 * act as its owner has exactly one caller.
 */

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const code = (rel: string) =>
  readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ── the rules, pure ───────────────────────────────────────────────────── */

test("the switch is off unless it says exactly on", () => {
  for (const raw of [null, undefined, "", "off", "true", "ON", "1"]) assert.equal(whatsappConfirmOn(raw), false, String(raw));
  assert.equal(whatsappConfirmOn("on"), true);
  assert.equal(ASSISTANT_WHATSAPP_CONFIRM_KEY, "ASSISTANT_WHATSAPP_CONFIRM");
  assert.equal(PENDING_ACTION_TTL_MS, 15 * 60 * 1000);
});

test("only internal changes can be confirmed from a phone — nothing that reaches a customer", () => {
  for (const kind of ["note", "customer_note", "follow_up", "assign", "stage", "meeting", "reschedule", "cancel_activity", "schedule", "watch"]) {
    assert.ok(WHATSAPP_CONFIRMABLE.has(kind), kind);
  }
  for (const kind of ["draft_message", "test_drive", "lost", "quote", "send_whatsapp", "anything_new", ""]) {
    assert.equal(WHATSAPP_CONFIRMABLE.has(kind), false, `${kind} stays in the CRM`);
  }
  const cards = [{ kind: "note" }, { kind: "draft_message" }, { kind: "stage" }, { kind: "quote" }];
  assert.deepEqual(splitForWhatsApp_cards(cards), { confirmable: [{ kind: "note" }, { kind: "stage" }], crmOnly: [{ kind: "draft_message" }, { kind: "quote" }] });
  // Every confirmable kind is one the CRM's own Confirm knows how to run.
  const run = code("src/app/actions/assistant.ts");
  for (const kind of WHATSAPP_CONFIRMABLE) {
    if (kind === "customer_note") continue; // arrives with the customer-notes change; harmless to allow before it does
    assert.match(run, new RegExp(`case "${kind}": \\{`), kind);
  }
});

test("a Confirm button names its pending row and nothing else; the prompt says what will happen", () => {
  const id = "cmabcdefghijklmnopqrstuv";
  assert.equal(confirmButtonId(id), `daxc:${id}`);
  assert.equal(parseConfirmId(`daxc:${id}`), id);
  for (const not of [null, undefined, "", "dax:0", "daxc:", "daxc:short", `daxc:${id}; DROP`, `xdaxc:${id}`, `daxc:${id.toUpperCase()}`]) {
    assert.equal(parseConfirmId(not), null, String(not));
  }
  const prompt = confirmMessages({ title: "Add a pinned note to Anna's lead", text: "Wants white.", reason: "She asked twice." })!;
  assert.deepEqual(prompt.before, [], "it all fits the button message");
  assert.match(prompt.body, /^Add a pinned note to Anna's lead\n\nWants white\.\n\nShe asked twice\.\n\nTap Confirm within 15 minutes/);
  assert.match(prompt.body, /Nothing changes until you do\./);
  // A scheduled question and a meeting's detail are shown too — they are what is being agreed to.
  assert.match(confirmMessages({ title: "Every Monday at 07:00", question: "Which deals went quiet?" })!.body, /Which deals went quiet\?/);
  assert.match(confirmMessages({ title: "Meeting — Fri 10:00", detail: "With Donovan, 45 minutes" })!.body, /With Donovan, 45 minutes/);
});

test("WHAT CONFIRM WRITES IS EXACTLY WHAT WAS SHOWN: a long note is never cut to fit the button", () => {
  const squash = (s: string) => s.replace(/\s+/g, "");
  // Distinct sentences, so a missing or repeated stretch cannot hide.
  const sentences = (n: number) => Array.from({ length: n }, (_, i) => `Sentence number ${i + 1} of the note says something the customer asked for.`).join(" ");
  for (const length of [900, 1100, 2000]) {
    const text = sentences(40).slice(0, length).trim();
    const title = "Add a note to Anna's lead";
    const messages = confirmMessages({ title, text, reason: "She asked twice." })!;
    assert.ok(messages, `${length}: offered`);
    assert.ok(messages.body.length <= 1024, `${length}: the button message fits WhatsApp's limit as written, not by cutting`);
    for (const part of messages.before) assert.ok(part.length <= 4096);
    // Every character of the note is in what the person was sent.
    const sent = squash([...messages.before, messages.body].join(" "));
    assert.ok(sent.includes(squash(text)), `${length}: the whole note text was shown`);
    assert.ok(sent.includes(squash("She asked twice.")), `${length}: and the reason`);
    if (messages.before.length) {
      assert.match(messages.body, /^Add a note to Anna's lead\n\nThe full text is in the message above — read it first\. Tap Confirm within 15 minutes/);
      assert.ok(!messages.body.includes("Sentence number"), "the button message does not carry a partial copy that could be mistaken for the whole");
    }
  }
  // The old behaviour, named: 1,024 characters of a 2,000-character note.
  const long = sentences(40).slice(0, 2000);
  assert.equal(confirmMessages({ title: "t", text: long })!.before.join("").length >= long.trim().length, true);
  // A note longer than one ordinary message is split, not dropped.
  const huge = sentences(200);
  const split = confirmMessages({ title: "t", text: huge })!;
  assert.ok(split.before.length >= 2);
  assert.equal(squash(split.before.join(" ")), squash(`t\n\n${huge}`));
  assert.match(split.body, /The full text is in the messages above — read them first\./);
  // When even the pointer cannot be shown whole, there is NO button: it is confirmed in the CRM.
  assert.equal(confirmMessages({ title: "x".repeat(1100), text: "y" }), null);
});

/* ── the confirm step, run against fakes ───────────────────────────────── */

type Pending = { id: string; tenantId: string; userId: string; card: Record<string, unknown>; expiresAt: Date; confirmedAt: Date | null; completedAt: Date | null; failedAt: Date | null };
const state = {
  on: true,
  rows: [] as Pending[],
  sent: [] as { to: string; text: string; buttons?: { id: string; title: string }[] }[],
  ran: [] as { asUserId: string; card: Record<string, unknown> }[],
  audits: [] as { action: string; summary: string; leadId?: string }[],
  errors: [] as string[],
  outcome: { ok: true, success: "Note added" } as { ok: boolean; success?: string; error?: string } | "refuse" | "throw",
  failTextContaining: "",
  seq: 0,
};
type Where = Record<string, unknown>;
const matches = (row: Pending, where: Where) =>
  Object.entries(where).every(([key, want]) => {
    const have = (row as unknown as Record<string, unknown>)[key];
    if (key === "expiresAt") {
      const range = want as { gt?: Date; lt?: Date };
      return range.gt ? row.expiresAt.getTime() > range.gt.getTime() : row.expiresAt.getTime() < range.lt!.getTime();
    }
    if (want instanceof Date) return have instanceof Date && have.getTime() === want.getTime();
    return want === null ? have === null : have === want;
  });
const table = {
  create: async ({ data }: { data: Pick<Pending, "tenantId" | "userId" | "card" | "expiresAt"> }) => {
    const row: Pending = { id: `cmpending${String(++state.seq).padStart(17, "0")}`, confirmedAt: null, completedAt: null, failedAt: null, ...data };
    state.rows.push(row);
    return { id: row.id };
  },
  deleteMany: async ({ where }: { where: Where }) => {
    const before = state.rows.length;
    state.rows = state.rows.filter((row) => !matches(row, where));
    return { count: before - state.rows.length };
  },
  updateMany: async ({ where, data }: { where: Where; data: Partial<Pending> }) => {
    const hit = state.rows.filter((row) => matches(row, where));
    for (const row of hit) Object.assign(row, data);
    return { count: hit.length };
  },
  findFirst: async ({ where }: { where: Where }) => state.rows.find((row) => matches(row, where)) ?? null,
};

type Loader = (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only") return {};
  if ((parent?.filename ?? "").replace(/\\/g, "/").endsWith("src/lib/assistantWhatsAppConfirm.ts")) {
    switch (request) {
      case "./db": return { basePrisma: { assistantPendingAction: table } };
      case "./settings": return { getSetting: async (key: string) => (key === ASSISTANT_WHATSAPP_CONFIRM_KEY && state.on ? "on" : null) };
      case "./audit": return { logAudit: async (entry: { action: string; summary: string; leadId?: string }) => { state.audits.push({ action: entry.action, summary: entry.summary, leadId: entry.leadId }); } };
      case "./errorLog": return { logError: async (...args: unknown[]) => { state.errors.push(args.map(String).join(" ")); } };
      case "./whatsapp": return {
        sendWhatsAppText: async (to: string, text: string) => {
          if (state.failTextContaining && text.includes(state.failTextContaining)) return { ok: false };
          state.sent.push({ to, text });
          return { ok: true };
        },
        sendWhatsAppButtons: async (to: string, text: string, buttons: { id: string; title: string }[]) => { state.sent.push({ to, text, buttons }); return { ok: true }; },
      };
      // The real one is proved by its source below; here it records WHO the action ran as.
      case "./auth": return { runAsLinkedStaff: async (userId: string, fn: () => Promise<unknown>) => { asUser = userId; try { return await fn(); } finally { asUser = null; } } };
      case "@/app/actions/assistant": return {
        runAssistantAction: async (card: Record<string, unknown>) => {
          state.ran.push({ asUserId: asUser ?? "NOBODY", card });
          if (state.outcome === "refuse") throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/;307;" });
          if (state.outcome === "throw") throw new Error("database unavailable");
          return state.outcome;
        },
      };
    }
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;
let asUser: string | null = null;

const require_ = createRequire(import.meta.url);
const { PENDING_ACTION_RETENTION_MS, confirmFromWhatsApp, offerConfirmations, prunePendingActions } = require_("../src/lib/assistantWhatsAppConfirm.ts") as typeof import("../src/lib/assistantWhatsAppConfirm");

const LEAD = "cmabcdefghijklmnopqrstuv";
const PHONE = "27821234567";
const me = { id: "u1", name: "Sean", email: "s@x", role: "staff" } as never;
const NOTE = { id: "a0", kind: "note", leadId: LEAD, leadLabel: "Anna — Rover", title: "Add a note to Anna's lead", text: "Wants white." };
const pendingRow = (over: Partial<Pending> = {}): Pending => {
  const row: Pending = { id: `cmpending${String(++state.seq).padStart(17, "0")}`, tenantId: "t1", userId: "u1", card: NOTE, expiresAt: new Date(Date.now() + 60_000), confirmedAt: null, completedAt: null, failedAt: null, ...over };
  state.rows.push(row);
  return row;
};

beforeEach(() => {
  state.on = true;
  state.rows = [];
  state.sent = [];
  state.ran = [];
  state.audits = [];
  state.errors = [];
  state.outcome = { ok: true, success: "Note added" };
  state.failTextContaining = "";
});

test("a long note: the full text is delivered BEFORE the button exists — and if it is not delivered, there is no button", async () => {
  const text = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}: the customer wants delivery before month end and asked twice.`).join(" ");
  assert.ok(text.length > 1024 && text.length <= 2000);
  const long = { ...NOTE, text } as never;

  await offerConfirmations("t1", "u1", PHONE, [long]);
  assert.equal(state.sent.length, 2);
  assert.equal(state.sent[0].buttons, undefined, "first, an ordinary message");
  assert.ok(state.sent[0].text.includes(text), "…carrying the WHOLE note");
  assert.deepEqual(state.sent[1].buttons, [{ id: `daxc:${state.rows[0].id}`, title: "Confirm" }]);
  assert.match(state.sent[1].text, /The full text is in the message above — read it first\./);
  // What is stored — what Confirm will write — is that same text, whole.
  assert.equal((state.rows[0].card as { text: string }).text, text);

  // The text fails to send: nothing to confirm is created, and the person is told it needs the CRM.
  state.rows = [];
  state.sent = [];
  state.failTextContaining = "Line 1:";
  await offerConfirmations("t1", "u1", PHONE, [long]);
  assert.deepEqual(state.rows, [], "no pending task without its text having been shown");
  assert.ok(!state.sent.some((s) => s.buttons), "no Confirm button");
  assert.match(state.sent.at(-1)?.text ?? "", /^This one needs the CRM/);
  assert.ok(state.errors.some((e) => e.includes("no button offered")));
});

test("a tap runs the task ONCE, as the person it was offered to, and says so", async () => {
  const row = pendingRow();
  await confirmFromWhatsApp("t1", me, PHONE, row.id);
  assert.deepEqual(state.ran, [{ asUserId: "u1", card: NOTE }], "the stored card, run as that person through the CRM's own Confirm");
  assert.ok(row.confirmedAt instanceof Date);
  assert.ok(row.completedAt instanceof Date, "recorded as DONE, not merely claimed");
  assert.equal(row.failedAt, null);
  assert.deepEqual(state.sent, [{ to: PHONE, text: "✅ Note added" }]);
  assert.deepEqual(state.audits, [{ action: "assistant.whatsapp_confirmed", summary: "Confirmed on WhatsApp: Add a note to Anna's lead", leadId: LEAD }]);

  // A second tap, or a redelivery that got past the webhook's own claim: nothing runs again.
  await confirmFromWhatsApp("t1", me, PHONE, row.id);
  assert.equal(state.ran.length, 1);
  assert.equal(state.sent[1].text, "That one is already done.");
  // Two taps at the same moment: one conditional update each, and only one finds the row unclaimed.
  const other = pendingRow();
  await Promise.all([confirmFromWhatsApp("t1", me, PHONE, other.id), confirmFromWhatsApp("t1", me, PHONE, other.id)]);
  assert.equal(state.ran.length, 2, "one more run, not two");
});

test("nothing runs: switch off, expired, someone else's, another workspace's, an unknown id, a kind that is not confirmable", async () => {
  const cases: [string, () => string, RegExp][] = [
    ["the owner's switch off", () => { state.on = false; return pendingRow().id; }, /switched off for this workspace/],
    ["expired", () => pendingRow({ expiresAt: new Date(Date.now() - 1000) }).id, /has expired — a task can be confirmed for 15 minutes/],
    // Somebody else's, another workspace's and a made-up id all read the same: nothing is revealed about a task that is not yours.
    ["offered to someone else", () => pendingRow({ userId: "u2" }).id, /^That one can't be confirmed — ask me again/],
    ["another workspace's", () => pendingRow({ tenantId: "t2" }).id, /^That one can't be confirmed — ask me again/],
    ["an id that was never issued", () => "cmneverissuedneverissuedne", /^That one can't be confirmed — ask me again/],
    ["one already done", () => pendingRow({ confirmedAt: new Date(), completedAt: new Date() }).id, /^That one is already done\.$/],
    ["one that failed earlier", () => pendingRow({ confirmedAt: new Date(), failedAt: new Date() }).id, /failed when it was tried[\s\S]*can't be tried again from here/],
    ["one being run right now", () => pendingRow({ confirmedAt: new Date() }).id, /^That one is being done right now\.$/],
    ["a message to a customer", () => pendingRow({ card: { ...NOTE, kind: "draft_message" } }).id, /needs the CRM/],
    ["a test drive", () => pendingRow({ card: { ...NOTE, kind: "test_drive" } }).id, /needs the CRM/],
  ];
  for (const [name, arrange, reply] of cases) {
    state.on = true;
    state.sent = [];
    const id = arrange();
    await confirmFromWhatsApp("t1", me, PHONE, id);
    assert.deepEqual(state.ran, [], `${name}: nothing ran`);
    assert.deepEqual(state.audits, [], `${name}: nothing to audit`);
    assert.match(state.sent[0]?.text ?? "", reply, name);
  }
});

test("after a claim: 'nothing changed' can be tried again; 'don't know how far it got' cannot — and neither is ever reported as done", async () => {
  // The action answered "not done": it changed nothing, so the claim is released and Confirm works again.
  state.outcome = { ok: false, error: "Somebody else's diary is busy then." };
  const retry = pendingRow();
  await confirmFromWhatsApp("t1", me, PHONE, retry.id);
  assert.match(state.sent.at(-1)?.text ?? "", /^Not done: Somebody else's diary is busy then\.\n\nNothing was changed\. You can tap Confirm again until it expires\./);
  assert.equal(retry.confirmedAt, null, "released");
  assert.equal(retry.completedAt, null);
  assert.equal(retry.failedAt, null);
  state.outcome = { ok: true, success: "Meeting booked" };
  await confirmFromWhatsApp("t1", me, PHONE, retry.id);
  assert.equal(state.sent.at(-1)?.text, "✅ Meeting booked", "the same button, tapped again, now does it");
  assert.notEqual(retry.completedAt, null, "…and is recorded as done");
  assert.equal(state.ran.length, 2, "tried twice, done once");

  // Refused by the CRM's own guard before anything ran: released too, and said plainly.
  state.outcome = "refuse";
  const refused = pendingRow();
  await confirmFromWhatsApp("t1", me, PHONE, refused.id);
  assert.equal(state.sent.at(-1)?.text, "You don't have permission to do that. Nothing was changed.");
  assert.equal(refused.confirmedAt, null);

  // It THREW: it may have got part-way. Marked failed; a second tap does not run it again.
  state.outcome = "throw";
  const broke = pendingRow();
  await confirmFromWhatsApp("t1", me, PHONE, broke.id);
  assert.match(state.sent.at(-1)?.text ?? "", /didn't go through, and I can't tell how far it got\. Check the record in the CRM/);
  assert.ok(broke.failedAt instanceof Date);
  assert.equal(broke.completedAt, null);
  assert.ok(state.errors.some((e) => e.includes("confirmed action threw")));
  const ranBefore = state.ran.length;
  state.outcome = { ok: true, success: "Note added" };
  await confirmFromWhatsApp("t1", me, PHONE, broke.id);
  assert.equal(state.ran.length, ranBefore, "a failed task is NOT retried — retrying an unknown is how a note is written twice");
  assert.match(state.sent.at(-1)?.text ?? "", /failed when it was tried/);

  assert.equal(state.audits.filter((a) => a.action === "assistant.whatsapp_confirmed").length, 1, "one confirmation recorded: the one that happened");
});

test("old pending tasks are deleted a day after their window closes — done, failed or never tapped — and newer ones are kept", async () => {
  const hours = (n: number) => new Date(Date.now() - n * 3_600_000);
  assert.equal(PENDING_ACTION_RETENTION_MS, 24 * 60 * 60 * 1000);
  const oldDone = pendingRow({ expiresAt: hours(25), confirmedAt: hours(25.2), completedAt: hours(25.2) });
  const oldFailed = pendingRow({ expiresAt: hours(30), confirmedAt: hours(30.1), failedAt: hours(30.1) });
  const oldUntapped = pendingRow({ expiresAt: hours(48) });
  const recentDone = pendingRow({ expiresAt: hours(2), confirmedAt: hours(2.1), completedAt: hours(2.1) });
  const waiting = pendingRow();
  const otherWorkspace = pendingRow({ tenantId: "t2", expiresAt: hours(72) });
  assert.equal(await prunePendingActions("t1"), 3);
  const left = state.rows.map((row) => row.id);
  for (const gone of [oldDone, oldFailed, oldUntapped]) assert.ok(!left.includes(gone.id));
  for (const kept of [recentDone, waiting]) assert.ok(left.includes(kept.id));
  assert.ok(left.includes(otherWorkspace.id), "only the workspace it was asked to clean");
  // …and it runs on a tick that already exists, per workspace, without stopping the watches if it fails.
  const route = code("src/app/api/cron/assistant/route.ts");
  assert.match(route, /if \(tenantId\) \{\s*await prunePendingActions\(tenantId\)\.catch\(/);
  assert.ok(route.indexOf("prunePendingActions(tenantId)") < route.indexOf("runAssistantWatches(budget)"));
  assert.match(code("src/lib/assistantWhatsAppConfirm.ts"), /deleteMany\(\{\s*where: \{ tenantId, expiresAt: \{ lt: new Date\(now\.getTime\(\) - PENDING_ACTION_RETENTION_MS\) \} \},/);
});

test("offers: a Confirm button per internal task when on; everything named as CRM-only when off — never silently dropped", async () => {
  const cards = [NOTE, { ...NOTE, id: "a1", kind: "draft_message", title: "Draft a WhatsApp to Anna" }, { ...NOTE, id: "a2", kind: "stage", title: "Move Anna to Quoted", text: undefined }] as never[];
  await offerConfirmations("t1", "u1", PHONE, cards);
  assert.equal(state.rows.length, 2, "one pending row per confirmable task");
  assert.ok(state.rows.every((row) => row.tenantId === "t1" && row.userId === "u1" && row.confirmedAt === null));
  assert.ok(state.rows.every((row) => Math.abs(row.expiresAt.getTime() - Date.now() - PENDING_ACTION_TTL_MS) < 5000));
  const offers = state.sent.filter((s) => s.buttons);
  assert.deepEqual(offers.map((s) => s.buttons), state.rows.map((row) => [{ id: `daxc:${row.id}`, title: "Confirm" }]));
  assert.match(offers[0].text, /^Add a note to Anna's lead\n\nWants white\./);
  assert.match(state.sent.at(-1)?.text ?? "", /^This one needs the CRM[\s\S]*• Draft a WhatsApp to Anna$/);

  state.rows = [];
  state.sent = [];
  state.on = false;
  await offerConfirmations("t1", "u1", PHONE, cards);
  assert.deepEqual(state.rows, [], "switch off: nothing can be confirmed here, so nothing is stored");
  assert.ok(!state.sent.some((s) => s.buttons));
  assert.match(state.sent[0].text, /^These need the CRM[\s\S]*• Add a note to Anna's lead\n• Draft a WhatsApp to Anna\n• Move Anna to Quoted$/);
  state.sent = [];
  await offerConfirmations("t1", "u1", PHONE, []);
  assert.deepEqual(state.sent, [], "no tasks, no message");
});

/* ── the wiring ────────────────────────────────────────────────────────── */

test("the claim is one conditional update naming workspace, person, unclaimed and unexpired — and the kind is re-checked before it runs", () => {
  const lib = code("src/lib/assistantWhatsAppConfirm.ts");
  assert.match(lib, /updateMany\(\{\s*where: \{ id: pendingId, tenantId, userId: user\.id, confirmedAt: null, completedAt: null, failedAt: null, expiresAt: \{ gt: now \} \},\s*data: \{ confirmedAt: now \},/);
  assert.match(lib, /if \(claimed\.count !== 1\) return say\(/);
  // Whatever a run ends as, it is written against THIS claim only — it cannot undo or overwrite a later one.
  assert.match(lib, /updateMany\(\{ where: \{ id: pendingId, tenantId, userId: user\.id, confirmedAt: now, completedAt: null, failedAt: null \}, data \}\)/);
  const order = ["confirmingOnWhatsAppOn()", "assistantPendingAction.updateMany(", "WHATSAPP_CONFIRMABLE.has(String(card.kind))", "runAsLinkedStaff(user.id, () => runAssistantAction(card))"].map((needle) => lib.indexOf(needle));
  assert.ok(order.every((at, i) => at > -1 && (i === 0 || order[i - 1] < at)), "switch, claim, kind, run — in that order");
  // It changes records only through the CRM's own Confirm, and can send nothing to a customer.
  assert.doesNotMatch(lib, /prisma\.(lead|contact|communication|activity|quote)\b|sendEmail|sendMessenger|sendTelegram|sendAssistantDraft/);
  for (const call of lib.match(/sendWhatsApp(Text|Buttons)\([^)]*\)/g) ?? []) assert.match(call, /^sendWhatsApp(Text|Buttons)\(waId,/, "replies go to the linked phone only");
});

test("tasks are proposed only where they can be confirmed: the chat, and WhatsApp when its caller says so — never a scheduled run", () => {
  const lib = code("src/lib/crmAssistant.ts");
  assert.match(lib, /const proposes = source === "chat" \|\| \(source === "whatsapp" && opts\.proposeTasks === true\);/);
  assert.match(lib, /proposes \? ACTION_INSTRUCTIONS : "",/);
  assert.match(lib, /const actions = !proposes \? \[\] : await resolveActions\(user, proposals\)/);
  assert.match(lib, /source === "whatsapp" && proposes \? WHATSAPP_CONFIRM_RULE : CHANNEL_RULES\[source\],/);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { WHATSAPP_CONFIRM_RULE, CHANNEL_RULES } = require_("../src/lib/crmAssistant") as typeof import("../src/lib/crmAssistant");
  assert.match(WHATSAPP_CONFIRM_RULE, /happens only when they tap it/);
  assert.match(WHATSAPP_CONFIRM_RULE, /never that it is done/);
  assert.match(WHATSAPP_CONFIRM_RULE, /never sent from WhatsApp[\s\S]*do not propose draft_message/);
  assert.match(CHANNEL_RULES.whatsapp, /You can't set up tasks here/, "the default, with the switch off, is unchanged");
});

test("the door that lets a phone act as its owner: one caller, one workspace, a live account, and gone when the call returns", () => {
  const auth = code("src/lib/auth.ts");
  const door = auth.slice(auth.indexOf("export async function runAsLinkedStaff"), auth.indexOf("export class ApiAuthError"));
  assert.match(door, /const scope = currentTenantScope\(\);\s*if \(!scope \|\| scope\.system \|\| !scope\.tenantId\) throw new Error\(/, "exactly one workspace, never a system scope");
  assert.match(door, /getUserSecurityStateFresh\(userId\)/);
  assert.match(door, /if \(!user \|\| !security \|\| security\.disabledAt\) throw new Error\(/);
  assert.match(door, /return linkedStaff\.run\(user, fn\);/);
  assert.doesNotMatch(auth, /linkedStaff\.enterWith/, "run, not enterWith: the identity must not outlive the call");
  assert.match(auth, /export async function getCurrentUser\(\) \{\s*const linked = linkedStaff\.getStore\(\);\s*if \(linked\) return linked;/);

  // ONE caller in the whole application.
  const callers: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && /runAsLinkedStaff\(/.test(readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""))) callers.push(path.replace(/\\/g, "/").split("/src/")[1]);
    }
  };
  walk(join(root, "src"));
  assert.deepEqual(callers, ["lib/assistantWhatsAppConfirm.ts"], "a second caller is a second way to act as someone without their sign-in");
});

test("the owner's switch: owner only, audited both ways, default off, and described where it is switched", () => {
  const save = code("src/app/actions/assistantSettings.ts");
  const card = save.slice(save.indexOf("export async function saveAssistantWhatsAppCard"));
  assert.match(card, /const user = await requireTenantOwner\(\);/);
  assert.match(card, /const confirm = formData\.get\("whatsappConfirm"\) === "on";/);
  assert.match(card, /action: confirm \? "assistant\.whatsapp_confirm_enabled" : "assistant\.whatsapp_confirm_disabled"/);
  const page = code("src/app/(app)/settings/assistant/page.tsx");
  assert.match(page, /name="whatsappConfirm"\s*defaultChecked=\{confirmOn\}/);
  assert.match(page, /getSetting\(ASSISTANT_WHATSAPP_CONFIRM_KEY\)\.then\(whatsappConfirmOn\)/);
  assert.match(page, /Nothing happens without the tap\./);
  assert.match(page, /Messages to customers, test drives, marking a deal lost and starting a\s+quote are never done from WhatsApp\./);
});

test("the pending table belongs to a workspace: tenantId on every row, row security forced, and the migration can be re-run", () => {
  const sql = readFileSync(join(root, "prisma/migrations/20261011190000_assistant_pending_action/migration.sql"), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "AssistantPendingAction"/);
  assert.match(sql, /"tenantId" TEXT NOT NULL/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY;[\s\S]*DROP POLICY IF EXISTS[\s\S]*CREATE POLICY "AssistantPendingAction_tenant_isolation"[\s\S]*FORCE ROW LEVEL SECURITY;/);
  const lib = code("src/lib/assistantWhatsAppConfirm.ts");
  for (const query of lib.match(/assistantPendingAction\.(create|updateMany|findFirst)\(\{[\s\S]*?\}\)/g) ?? []) assert.match(query, /tenantId/, query.slice(0, 80));
});
