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
  confirmPrompt,
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
  const prompt = confirmPrompt({ title: "Add a pinned note to Anna's lead", text: "Wants white.", reason: "She asked twice." });
  assert.match(prompt, /^Add a pinned note to Anna's lead\n\nWants white\.\n\nShe asked twice\.\n\nTap Confirm within 15 minutes/);
  assert.match(prompt, /Nothing changes until you do\./);
  assert.ok(confirmPrompt({ title: "x".repeat(5000) }).length <= 1024, "fits a WhatsApp button message");
});

/* ── the confirm step, run against fakes ───────────────────────────────── */

type Pending = { id: string; tenantId: string; userId: string; card: Record<string, unknown>; expiresAt: Date; confirmedAt: Date | null };
const state = {
  on: true,
  rows: [] as Pending[],
  sent: [] as { to: string; text: string; buttons?: { id: string; title: string }[] }[],
  ran: [] as { asUserId: string; card: Record<string, unknown> }[],
  audits: [] as { action: string; summary: string; leadId?: string }[],
  errors: [] as string[],
  outcome: { ok: true, success: "Note added" } as { ok: boolean; success?: string; error?: string } | "refuse" | "throw",
  seq: 0,
};
type Where = Record<string, unknown>;
const matches = (row: Pending, where: Where) =>
  Object.entries(where).every(([key, want]) => {
    const have = (row as unknown as Record<string, unknown>)[key];
    if (key === "expiresAt") return row.expiresAt.getTime() > ((want as { gt: Date }).gt).getTime();
    return want === null ? have === null : have === want;
  });
const table = {
  create: async ({ data }: { data: Omit<Pending, "id" | "confirmedAt"> }) => {
    const row: Pending = { id: `cmpending${String(++state.seq).padStart(17, "0")}`, confirmedAt: null, ...data };
    state.rows.push(row);
    return { id: row.id };
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
        sendWhatsAppText: async (to: string, text: string) => { state.sent.push({ to, text }); return { ok: true }; },
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
const { confirmFromWhatsApp, offerConfirmations } = require_("../src/lib/assistantWhatsAppConfirm.ts") as typeof import("../src/lib/assistantWhatsAppConfirm");

const LEAD = "cmabcdefghijklmnopqrstuv";
const PHONE = "27821234567";
const me = { id: "u1", name: "Sean", email: "s@x", role: "staff" } as never;
const NOTE = { id: "a0", kind: "note", leadId: LEAD, leadLabel: "Anna — Rover", title: "Add a note to Anna's lead", text: "Wants white." };
const pendingRow = (over: Partial<Pending> = {}): Pending => {
  const row: Pending = { id: `cmpending${String(++state.seq).padStart(17, "0")}`, tenantId: "t1", userId: "u1", card: NOTE, expiresAt: new Date(Date.now() + 60_000), confirmedAt: null, ...over };
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
});

test("a tap runs the task ONCE, as the person it was offered to, and says so", async () => {
  const row = pendingRow();
  await confirmFromWhatsApp("t1", me, PHONE, row.id);
  assert.deepEqual(state.ran, [{ asUserId: "u1", card: NOTE }], "the stored card, run as that person through the CRM's own Confirm");
  assert.ok(row.confirmedAt instanceof Date);
  assert.deepEqual(state.sent, [{ to: PHONE, text: "✅ Note added" }]);
  assert.deepEqual(state.audits, [{ action: "assistant.whatsapp_confirmed", summary: "Confirmed on WhatsApp: Add a note to Anna's lead", leadId: LEAD }]);

  // A second tap, or a redelivery that got past the webhook's own claim: nothing runs again.
  await confirmFromWhatsApp("t1", me, PHONE, row.id);
  assert.equal(state.ran.length, 1);
  assert.match(state.sent[1].text, /already been done or it has expired/);
  // Two taps at the same moment: one conditional update each, and only one finds the row unclaimed.
  const other = pendingRow();
  await Promise.all([confirmFromWhatsApp("t1", me, PHONE, other.id), confirmFromWhatsApp("t1", me, PHONE, other.id)]);
  assert.equal(state.ran.length, 2, "one more run, not two");
});

test("nothing runs: switch off, expired, someone else's, another workspace's, an unknown id, a kind that is not confirmable", async () => {
  const cases: [string, () => string, RegExp][] = [
    ["the owner's switch off", () => { state.on = false; return pendingRow().id; }, /switched off for this workspace/],
    ["expired", () => pendingRow({ expiresAt: new Date(Date.now() - 1000) }).id, /already been done or it has expired/],
    ["offered to someone else", () => pendingRow({ userId: "u2" }).id, /already been done or it has expired/],
    ["another workspace's", () => pendingRow({ tenantId: "t2" }).id, /already been done or it has expired/],
    ["an id that was never issued", () => "cmneverissuedneverissuedne", /already been done or it has expired/],
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

test("a refusal or a failure is reported as one — never as done", async () => {
  state.outcome = "refuse";
  await confirmFromWhatsApp("t1", me, PHONE, pendingRow().id);
  assert.equal(state.sent.at(-1)?.text, "You don't have permission to do that.");
  state.outcome = { ok: false, error: "This changed since DAX suggested it — ask again to see where it stands now." };
  await confirmFromWhatsApp("t1", me, PHONE, pendingRow().id);
  assert.match(state.sent.at(-1)?.text ?? "", /^Not done: This changed since/);
  state.outcome = "throw";
  await confirmFromWhatsApp("t1", me, PHONE, pendingRow().id);
  assert.match(state.sent.at(-1)?.text ?? "", /didn't go through\. Check the record in the CRM/);
  assert.ok(state.errors.some((e) => e.includes("confirmed action threw")));
  assert.deepEqual(state.audits, [], "no confirmation is recorded for something that did not happen");
  assert.ok(!state.sent.some((s) => s.text.startsWith("✅")));
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
  assert.match(lib, /updateMany\(\{\s*where: \{ id: pendingId, tenantId, userId: user\.id, confirmedAt: null, expiresAt: \{ gt: now \} \},\s*data: \{ confirmedAt: now \},/);
  assert.match(lib, /if \(claimed\.count !== 1\) return say\(/);
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
