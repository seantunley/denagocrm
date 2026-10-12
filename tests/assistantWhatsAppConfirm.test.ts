import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Module, { createRequire } from "node:module";
import {
  ASSISTANT_WHATSAPP_CONFIRM_KEY,
  CRM_CARD_TTL_MS,
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
  for (const kind of WHATSAPP_CONFIRMABLE) assert.match(run, new RegExp(`case "${kind}": \\{`), kind);
  // …and a customer note is audited on the CUSTOMER it changed.
  assert.match(code("src/lib/assistantWhatsAppConfirm.ts"), /\.\.\.\(card\.kind === "customer_note" \? \{ contactId: card\.contactId \} : \{\}\),/);
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

type Pending = { id: string; tenantId: string; userId: string; card: Record<string, unknown>; expiresAt: Date; confirmedAt: Date | null; completedAt: Date | null; failedAt: Date | null; forCrm: boolean };
const state = {
  on: true,
  /** The database refusing to save a card for the CRM. */
  saveFails: false,
  rows: [] as Pending[],
  sent: [] as { to: string; text: string; buttons?: { id: string; title: string }[] }[],
  ran: [] as { asUserId: string; card: Record<string, unknown> }[],
  audits: [] as { action: string; summary: string; leadId?: string }[],
  errors: [] as string[],
  outcome: { ok: true, success: "Note added" } as { ok: boolean; success?: string; error?: string; unchanged?: boolean } | "refuse" | "throw",
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
    const row: Pending = { id: `cmpending${String(++state.seq).padStart(17, "0")}`, confirmedAt: null, completedAt: null, failedAt: null, forCrm: false, ...data };
    state.rows.push(row);
    return { id: row.id };
  },
  createMany: async ({ data }: { data: (Pick<Pending, "tenantId" | "userId" | "card" | "expiresAt"> & { forCrm?: boolean })[] }) => {
    if (state.saveFails) throw new Error("database unavailable");
    for (const item of data) state.rows.push({ id: `cmpending${String(++state.seq).padStart(17, "0")}`, confirmedAt: null, completedAt: null, failedAt: null, forCrm: false, ...item });
    return { count: data.length };
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
  const row: Pending = { id: `cmpending${String(++state.seq).padStart(17, "0")}`, tenantId: "t1", userId: "u1", card: NOTE, expiresAt: new Date(Date.now() + 60_000), confirmedAt: null, completedAt: null, failedAt: null, forCrm: false, ...over };
  state.rows.push(row);
  return row;
};

beforeEach(() => {
  state.on = true;
  state.saveFails = false;
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

  // The text fails to send: nothing that a PHONE can confirm is created — it is kept for the CRM instead.
  state.rows = [];
  state.sent = [];
  state.failTextContaining = "Line 1:";
  await offerConfirmations("t1", "u1", PHONE, [long]);
  assert.deepEqual(state.rows.filter((row) => !row.forCrm), [], "no button-confirmable task without its text having been shown");
  assert.equal(state.rows.length, 1, "kept as a card for the CRM, with the whole note");
  assert.equal((state.rows[0].card as { text: string }).text, text);
  assert.ok(!state.sent.some((s) => s.buttons), "no Confirm button");
  assert.match(state.sent.at(-1)?.text ?? "", /^This one is done in the CRM\. I've saved it on your Ask page/);
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
    // A card SAVED for the CRM — even of a kind a phone may confirm — is no task at all as far as a phone is concerned.
    ["a card saved for the CRM", () => pendingRow({ forCrm: true, expiresAt: new Date(Date.now() + 3_600_000) }).id, /^That one can't be confirmed — ask me again/],
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
  // PROVEN unchanged — turned away before anything that writes was called: released, and Confirm works again.
  state.outcome = { ok: false, error: "This changed since DAX suggested it — ask again to see where it stands now.", unchanged: true };
  const retry = pendingRow();
  await confirmFromWhatsApp("t1", me, PHONE, retry.id);
  assert.match(state.sent.at(-1)?.text ?? "", /^Not done: This changed since DAX suggested it[\s\S]*\n\nNothing was changed\. You can tap Confirm again until it expires\./);
  assert.equal(retry.confirmedAt, null, "released");
  assert.equal(retry.completedAt, null);
  assert.equal(retry.failedAt, null);
  state.outcome = { ok: true, success: "Lead moved" };
  await confirmFromWhatsApp("t1", me, PHONE, retry.id);
  assert.equal(state.sent.at(-1)?.text, "✅ Lead moved", "the same button, tapped again, now does it");
  assert.notEqual(retry.completedAt, null, "…and is recorded as done");
  assert.equal(state.ran.length, 2, "tried twice, done once");

  // An error that came back FROM the action, with no proof: NOT released. The words do not claim nothing changed.
  state.outcome = { ok: false, error: "Somebody else's diary is busy then." };
  const unproven = pendingRow();
  await confirmFromWhatsApp("t1", me, PHONE, unproven.id);
  assert.match(state.sent.at(-1)?.text ?? "", /^That didn't complete: Somebody else's diary is busy then\.\n\nPart of it may have been saved, so I won't try it again from here\./);
  assert.ok(unproven.failedAt instanceof Date, "failed, not released");
  assert.doesNotMatch(state.sent.at(-1)?.text ?? "", /Nothing was changed|tap Confirm again/);

  // Refused by a guard: it ends there too — from here a refusal before a write and one part-way look the same.
  state.outcome = "refuse";
  const refused = pendingRow();
  await confirmFromWhatsApp("t1", me, PHONE, refused.id);
  assert.equal(state.sent.at(-1)?.text, "You don't have permission to do that.");
  assert.ok(refused.failedAt instanceof Date);

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

test("A PINNED NOTE WHOSE PIN FAILS IS NOT WRITTEN TWICE: the note was saved, so the same Confirm cannot run again", async () => {
  // What addCommunication does when the pin fails after the note is created: the note is in
  // the database, and an error comes back. Simulated here at that boundary — the real thing
  // is run against a database, with the pin made to fail, in the end-to-end script.
  const notes: string[] = [];
  const pinned = { ...NOTE, title: "Add a pinned note to Anna's lead", pin: true };
  const row = pendingRow({ card: pinned });
  state.outcome = { ok: false, error: "Couldn't save that — try again." };
  const writeThenFail = state.ran;
  await confirmFromWhatsApp("t1", me, PHONE, row.id);
  for (const run of writeThenFail) if (run.card === pinned) notes.push(String(run.card.text)); // the write that DID happen
  assert.deepEqual(notes, ["Wants white."]);
  assert.ok(row.failedAt instanceof Date, "ended: how far it got is not known to be 'nowhere'");
  assert.equal(row.confirmedAt instanceof Date, true, "and NOT released");
  assert.match(state.sent.at(-1)?.text ?? "", /Part of it may have been saved, so I won't try it again from here\. Check the record in the CRM/);

  // The same button again — and again, and twice at once.
  state.outcome = { ok: true, success: "Note added and pinned" };
  await confirmFromWhatsApp("t1", me, PHONE, row.id);
  await Promise.all([confirmFromWhatsApp("t1", me, PHONE, row.id), confirmFromWhatsApp("t1", me, PHONE, row.id)]);
  assert.equal(state.ran.filter((run) => run.card === pinned).length, 1, "the action ran ONCE: no second note");
  assert.ok(state.sent.slice(-3).every((s) => /failed when it was tried/.test(s.text)));
  assert.equal(state.audits.length, 0, "and nothing is recorded as confirmed");

  // The proof is given only where it can be: `unchanged` is set on returns made BEFORE a write-capable call…
  const action = code("src/app/actions/assistant.ts");
  const run = action.slice(action.indexOf("export async function runAssistantAction"), action.indexOf("export async function sendAssistantDraft"));
  assert.match(action, /const untouched = \(error: string\) => \(\{ ok: false as const, error, unchanged: true as const \}\);/);
  assert.equal((run.match(/return untouched\(/g) ?? []).length, 10);
  // …and never on an error handed back by the action a card delegates to.
  for (const delegated of run.match(/if \((?:!result\.ok|result\??\.error|!saved(?:\.ok)?)\) (?:\{\s*)?return [^\n]*/g) ?? []) {
    assert.doesNotMatch(delegated, /untouched|unchanged/, delegated);
  }
  assert.ok((run.match(/if \((?:!result\.ok|result\??\.error)\) return \{ ok: false/g) ?? []).length >= 10, "every delegate's error is returned unproven");
  // Every `untouched` return precedes the call that could write, within its own case.
  for (const block of run.split(/\n      case "/).slice(1)) {
    const firstWrite = block.search(/await (scheduleFollowUp|addCommunication|assignLead|moveLead|scheduleActivity|createTestDriveBooking|rescheduleActivity|cancelActivity|markLost|createQuoteFromLead|createWatchForUser|withScheduleSlot)\(/);
    const lastUntouched = block.lastIndexOf("return untouched(");
    if (lastUntouched > -1 && firstWrite > -1) assert.ok(lastUntouched < firstWrite, block.slice(0, 30));
  }
  // And the caller releases on that proof alone.
  const lib = code("src/lib/assistantWhatsAppConfirm.ts");
  assert.match(lib, /if \(result\.unchanged === true\) \{\s*await settle\(\{ confirmedAt: null \}\);/);
  assert.equal((lib.match(/settle\(\{ confirmedAt: null \}\)/g) ?? []).length, 1, "one way to release a claim, and it needs the proof");
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

test("offers: a Confirm button per internal task when on; everything else SAVED as a card for the CRM — never silently dropped, never asked for twice", async () => {
  const cards = [NOTE, { ...NOTE, id: "a1", kind: "draft_message", title: "Draft a WhatsApp to Anna" }, { ...NOTE, id: "a2", kind: "stage", title: "Move Anna to Quoted", text: undefined }] as never[];
  await offerConfirmations("t1", "u1", PHONE, cards);
  const buttons = state.rows.filter((row) => !row.forCrm);
  const kept = state.rows.filter((row) => row.forCrm);
  assert.equal(buttons.length, 2, "one pending row per confirmable task");
  assert.ok(state.rows.every((row) => row.tenantId === "t1" && row.userId === "u1" && row.confirmedAt === null));
  assert.ok(buttons.every((row) => Math.abs(row.expiresAt.getTime() - Date.now() - PENDING_ACTION_TTL_MS) < 5000));
  const offers = state.sent.filter((s) => s.buttons);
  assert.deepEqual(offers.map((s) => s.buttons), buttons.map((row) => [{ id: `daxc:${row.id}`, title: "Confirm" }]));
  assert.match(offers[0].text, /^Add a note to Anna's lead\n\nWants white\./);
  // The customer message is kept as a card — the whole card, for a day — and no button is ever sent for it.
  assert.equal(kept.length, 1);
  assert.equal(kept[0].card.kind, "draft_message");
  assert.ok(Math.abs(kept[0].expiresAt.getTime() - Date.now() - CRM_CARD_TTL_MS) < 5000);
  assert.ok(!state.sent.some((s) => s.buttons?.some((b) => b.id.includes(kept[0].id))), "a saved card never has a WhatsApp button");
  assert.match(state.sent.at(-1)?.text ?? "", /^This one is done in the CRM\. I've saved it on your Ask page — open it and press Confirm \(kept for a day\):\n• Draft a WhatsApp to Anna$/);

  state.rows = [];
  state.sent = [];
  state.on = false;
  await offerConfirmations("t1", "u1", PHONE, cards);
  assert.equal(state.rows.length, 3, "switch off: nothing can be confirmed on the phone, so all three are kept for the CRM");
  assert.ok(state.rows.every((row) => row.forCrm), "and none of them is a phone-confirmable task");
  assert.ok(!state.sent.some((s) => s.buttons));
  assert.match(state.sent[0].text, /^These are done in the CRM\. I've saved them on your Ask page[\s\S]*• Add a note to Anna's lead\n• Draft a WhatsApp to Anna\n• Move Anna to Quoted$/);

  // The save fails: the message must not promise a card that is not there.
  state.rows = [];
  state.sent = [];
  state.saveFails = true;
  await offerConfirmations("t1", "u1", PHONE, cards);
  assert.deepEqual(state.rows, []);
  assert.match(state.sent[0].text, /^These need the CRM — ask me there and confirm on the card:/);
  assert.ok(state.errors.some((e) => e.includes("saving a task for the CRM failed")));
  state.saveFails = false;
  state.sent = [];
  await offerConfirmations("t1", "u1", PHONE, []);
  assert.deepEqual(state.sent, [], "no tasks, no message");
});

/* ── the wiring ────────────────────────────────────────────────────────── */

test("the claim is one conditional update naming workspace, person, unclaimed and unexpired — and the kind is re-checked before it runs", () => {
  const lib = code("src/lib/assistantWhatsAppConfirm.ts");
  assert.match(lib, /where: \{ id: pendingId, tenantId, userId: user\.id, forCrm: false, confirmedAt: null, completedAt: null, failedAt: null, expiresAt: \{ gt: now \} \},\s*data: \{ confirmedAt: now \},/);
  assert.match(lib, /if \(claimed\.count !== 1\) return say\(/);
  // Whatever a run ends as, it is written against THIS claim only — it cannot undo or overwrite a later one.
  assert.match(lib, /updateMany\(\{ where: \{ id: pendingId, tenantId, userId: user\.id, confirmedAt: now, completedAt: null, failedAt: null \}, data \}\)/);
  const order = ["confirmingOnWhatsAppOn()", "assistantPendingAction.updateMany(", "WHATSAPP_CONFIRMABLE.has(String(card.kind))", "runAsLinkedStaff(user.id, () => runAssistantAction(card))"].map((needle) => lib.indexOf(needle));
  assert.ok(order.every((at, i) => at > -1 && (i === 0 || order[i - 1] < at)), "switch, claim, kind, run — in that order");
  // It changes records only through the CRM's own Confirm, and can send nothing to a customer.
  assert.doesNotMatch(lib, /prisma\.(lead|contact|communication|activity|quote)\b|sendEmail|sendMessenger|sendTelegram|sendAssistantDraft/);
  for (const call of lib.match(/sendWhatsApp(Text|Buttons)\([^)]*\)/g) ?? []) assert.match(call, /^sendWhatsApp(Text|Buttons)\(waId,/, "replies go to the linked phone only");
});

test("tasks are proposed only where they can be confirmed: the chat, and WhatsApp when its caller says what it will do with one — never a scheduled run", () => {
  const lib = code("src/lib/crmAssistant.ts");
  assert.match(lib, /const proposes = source === "chat" \|\| \(source === "whatsapp" && \(opts\.proposeTasks === true \|\| opts\.proposeTasks === "saved"\)\);/);
  assert.match(lib, /proposes \? ACTION_INSTRUCTIONS : "",/);
  assert.match(lib, /const actions = !proposes \? \[\] : await resolveActions\(user, proposals\)/);
  assert.match(lib, /if \(source !== "whatsapp" \|\| !proposes\) return CHANNEL_RULES\[source\];\s*return proposeTasks === "saved" \? WHATSAPP_SAVED_RULE : WHATSAPP_CONFIRM_RULE;/);
  assert.match(lib, /channelRule\(source, proposes, opts\.proposeTasks\),/);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { WHATSAPP_CONFIRM_RULE, WHATSAPP_SAVED_RULE, CHANNEL_RULES } = require_("../src/lib/crmAssistant") as typeof import("../src/lib/crmAssistant");
  assert.match(WHATSAPP_CONFIRM_RULE, /happens only when they tap it/);
  assert.match(WHATSAPP_CONFIRM_RULE, /never that it is done/);
  // What a phone may never do is told to the assistant as SAVED for the CRM — never as sent or done.
  assert.match(WHATSAPP_CONFIRM_RULE, /never done from WhatsApp[\s\S]*saved as a card on their Ask page[\s\S]*never that it was sent or done/);
  // The default, with the owner's switch off: nothing changes from the phone, and the assistant must not say otherwise.
  assert.match(WHATSAPP_SAVED_RULE, /Nothing can be changed from here/);
  assert.match(WHATSAPP_SAVED_RULE, /saved as a card on their Ask page in the CRM/);
  assert.match(WHATSAPP_SAVED_RULE, /never that it is done, and never that anything was sent/);
  assert.doesNotMatch(WHATSAPP_SAVED_RULE, /Confirm button and happens|tap it/);
  // A caller that says nothing still gets no tasks (a scheduled run, an older caller).
  assert.match(CHANNEL_RULES.whatsapp, /You can't set up tasks here/);
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

/* ── cards saved for the CRM ───────────────────────────────────────────── */

test("a card saved for the CRM is stamped with its workspace and person, and the phone path cannot reach it", () => {
  const lib = code("src/lib/assistantWhatsAppConfirm.ts");
  assert.match(lib, /createMany\(\{\s*data: cards\.map\(\(card\) => \(\{ tenantId, userId, card: card as object, expiresAt, forCrm: true \}\)\),/);
  // Saved BEFORE the person is told so, and the wording follows what actually happened.
  assert.ok(lib.indexOf("const saved = await saveForCrm(tenantId, userId, elsewhere);") < lib.indexOf("I've saved"));
  // Both phone-side lookups exclude saved cards: the claim, and the "why not" that follows a failed claim.
  assert.equal(lib.match(/forCrm: false/g)?.length, 2);
  const sql = readFileSync(join(root, "prisma/migrations/20261012110000_assistant_pending_for_crm/migration.sql"), "utf8");
  assert.match(sql, /ALTER TABLE "AssistantPendingAction" ADD COLUMN IF NOT EXISTS "forCrm" BOOLEAN NOT NULL DEFAULT false;/);
});

test("confirming a saved card in the CRM: the stored card, the person's own, at most once — and a customer message is never sent by Confirm", () => {
  const actions = code("src/app/actions/assistant.ts");
  const confirm = actions.slice(actions.indexOf("export async function confirmSavedAssistantCard"), actions.indexOf("export async function settleSavedAssistantCard"));
  // The same gate as every other assistant action, then ONE conditional update as the claim.
  assert.match(confirm, /const user = await requireAnyPermission\(\.\.\.ASSISTANT_PERMISSIONS\);/);
  assert.match(confirm, /updateMany\(\{\s*where: \{ id, userId: user\.id, forCrm: true, confirmedAt: null, completedAt: null, failedAt: null, expiresAt: \{ gt: now \} \},\s*data: \{ confirmedAt: now \},/);
  assert.match(confirm, /if \(claimed\.count !== 1\) return \{ ok: false, error: "That card is no longer waiting/);
  // What runs is read from the database by the person's own id — nothing the page sent but which row.
  assert.match(confirm, /findFirst\(\{ where: \{ id, userId: user\.id, forCrm: true \}, select: \{ card: true \} \}\)/);
  assert.match(confirm, /await runAssistantAction\(card\)/);
  assert.doesNotMatch(confirm, /savedId\.|JSON\.parse|formData/);
  // Done, proven-unchanged (released) and unknown (failed, never retried) are three different endings, each guarded on this claim.
  assert.match(confirm, /where: \{ id, userId: user\.id, forCrm: true, confirmedAt: now, completedAt: null, failedAt: null \}, data \}\)/);
  assert.match(confirm, /if \(result\.ok\) await settle\(\{ completedAt: new Date\(\) \}\);\s*else if \(result\.unchanged === true\) await settle\(\{ confirmedAt: null \}\);\s*else await settle\(\{ failedAt: new Date\(\) \}\);/);
  assert.match(confirm, /catch \(error\) \{\s*await settle\(\{ failedAt: new Date\(\) \}\);\s*throw error;/);
  // A drafted customer message has its own Send, where the wording is read first.
  assert.match(confirm, /card\.kind === "draft_message"\) \{\s*await settle\(\{ failedAt: new Date\(\) \}\);/);
  assert.doesNotMatch(confirm, /sendAssistantDraft|sendWhatsApp|sendEmail/);

  const settle = actions.slice(actions.indexOf("export async function settleSavedAssistantCard")).split("\n/**")[0];
  assert.match(settle, /const user = await requireAnyPermission\(\.\.\.ASSISTANT_PERMISSIONS\);/);
  assert.match(settle, /deleteMany\(\{ where: \{ id, userId: user\.id, forCrm: true, completedAt: null \} \}\)/);
  assert.match(settle, /updateMany\(\{ where: \{ id, userId: user\.id, forCrm: true, completedAt: null \}, data: \{ completedAt: new Date\(\) \} \}\)/);
});

test("the Ask page shows a person only their own waiting saved cards, and the card settles on the server", () => {
  const page = code("src/app/(app)/assistant/page.tsx");
  assert.match(page, /prisma\.assistantPendingAction\.findMany\(\{\s*where: \{ userId: user\.id, forCrm: true, confirmedAt: null, completedAt: null, failedAt: null, expiresAt: \{ gt: new Date\(\) \} \},/);
  // ALWAYS rendered, and it holds the list the visit started with: confirming a card runs a CRM
  // action that refreshes the page, and a card rendered from the fresh list would vanish before "Done" was read.
  assert.match(page, /\n\s*<SavedAssistantCards name=\{profile\.name\} cards=\{savedCards\} \/>/);
  assert.doesNotMatch(page, /savedCards\.length > 0 &&/);
  const list = code("src/components/SavedAssistantCards.tsx");
  assert.match(list, /const \[held\] = useState\(cards\);\s*if \(held\.length === 0\) return null;/);
  assert.match(list, /<AssistantActionCard key=\{saved\.id\} card=\{saved\.card\} savedId=\{saved\.id\} \/>/);
  assert.match(list, /Nothing happens until you press Confirm or Send/);
  // …and the two actions do not refresh the page themselves.
  const actions = code("src/app/actions/assistant.ts");
  const savedActions = actions.slice(actions.indexOf("export async function confirmSavedAssistantCard")).split("\n/**\n * 👍")[0];
  assert.doesNotMatch(savedActions.replace(/\/\/.*$/gm, ""), /revalidatePath\(/);
  const card = code("src/components/AssistantActionCard.tsx");
  // A saved card that was tried and may have got part-way loses its Confirm button: it will not run again.
  assert.match(card, /else if \(savedId && !\("unreached" in result\) && !\("unchanged" in result && result\.unchanged === true\)\) \{[\s\S]*?setState\("failed"\);/);
  assert.match(card, /await \(savedId \? confirmSavedAssistantCard\(savedId\) : runAssistantAction\(card\)\)/);
  // Dismissing a saved card removes it for good; a sent draft is marked done; and a saved draft keeps ONE send id across reloads.
  assert.match(card, /if \(savedId\) void settleSavedAssistantCard\(savedId, "dismissed"\)/);
  assert.match(card, /if \(savedId\) await settleSavedAssistantCard\(savedId, "sent"\)/);
  assert.match(card, /savedId \? `dax-saved-\$\{savedId\}` : /);
});
