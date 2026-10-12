import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import Module, { createRequire } from "node:module";
import {
  LINK_CODE_POLICY,
  LINK_CODE_TTL_MS,
  LINK_GUESS_POLICY,
  LINK_GUESS_WORKSPACE_POLICY,
  NUDGE_RETRY_MS,
  PROACTIVE_SOURCES,
  UPDATE_CLAIM_MS,
  UPDATE_MAX,
  UPDATE_SEND_RESERVE_MS,
  nudgeFailureMayPass,
  updateText,
  formatUpdateTemplate,
  outsideReplyWindow,
  parseUpdateTemplate,
  replyWindowOpen,
  businessNumberFromLabel,
  formatLinkCode,
  linkCodeHashInput,
  linkCodeText,
  linkRefusalText,
  maskWaId,
  parseLinkCode,
  planWhatsAppReply,
  splitForWhatsApp,
  waMeLink,
  whatsappSwitchOn,
} from "../src/lib/assistantWhatsAppRules";

/*
 * DAX on WhatsApp. The risk is one sentence: a CUSTOMER must never be answered as
 * staff. So these prove the gate behaviourally — handleStaffWhatsApp run against
 * an in-memory link table, with every collaborator faked — and then pin the
 * wiring: the route asks it first and skips the customer path only on a yes.
 */

const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/* ── fakes ─────────────────────────────────────────────────────────────── */

type Link = {
  id: string; tenantId: string; userId: string;
  waId: string | null; codeHash: string | null; codeExpiresAt: Date | null; verifiedAt: Date | null;
  sessionVersion?: number | null;
  refusedReason?: string | null;
  updatesOnWhatsApp?: boolean; nudgedAt?: Date | null; nudgeFailedAt?: Date | null; lastInboundAt?: Date | null;
};
/** An answer in a person's history. Only schedule and watch ones are ever sent to a phone. */
type Turn = { id: string; tenantId: string; userId: string; source: string; question: string; answer: string; createdAt: Date; whatsappSentAt: Date | null; whatsappClaimedAt: Date | null; whatsappPartsSent: number; quoteId?: string | null };
type Where = Record<string, unknown>;

type Scope = { tenantId: string | null; system: boolean } | undefined;
const state = {
  scope: { tenantId: "t1", system: false } as Scope,
  /** Every where clause the link table was asked, and every write's data. */
  queries: [] as Where[],
  writes: [] as Where[],
  switch: "on" as string | null,
  links: [] as Link[],
  members: new Set<string>(["u1", "u2"]),
  sent: [] as { to: string; text: string; buttons?: string[] }[],
  asked: [] as { userId: string; question: string; source?: string }[],
  mediaFetched: 0,
  typing: [] as { id: string; sentBefore: number }[],
  media: null as { buffer: Buffer; contentType: string } | null,
  imageAllowed: true,
  askedImages: [] as string[][],
  confirmOn: false,
  proposals: [] as { kind: string; title: string }[],
  proposeTasks: [] as (boolean | "saved")[],
  offered: [] as { tenantId: string; userId: string; waId: string; kinds: string[]; sentBefore: number }[],
  confirmed: [] as { tenantId: string; userId: string; waId: string; pendingId: string }[],
  errors: [] as string[],
  audits: [] as string[],
  guesses: new Map<string, number>(),
  asks: new Map<string, number>(),
  customers: new Set<string>(),
  ambiguous: new Set<string>(),
  /** Each account's current sessionVersion (bumped by a password reset / sign out everywhere). */
  sessionVersions: new Map<string, number>(),
  securityDown: false,
  turns: [] as Turn[],
  /** The owner's template setting, as stored. */
  template: null as string | null,
  templatesSent: [] as { to: string; name: string; language: string }[],
  /** Meta refusing a text for the 24-hour rule although our clock said it was open. */
  metaRefuses: false,
  /** Texts fail once this many have gone (null = never). */
  textFailsFrom: null as number | null,
  /** The template send's failure: an error text, "throws", or null for success. */
  templateFails: null as string | null,
  templateTries: 0,
  /** Run as each text is accepted: time passing, or another sender acting meanwhile. */
  onSend: null as (() => void) | null,
  /** Quotes in the database, for a built quote's PDF. */
  quotes: [] as { id: string; tenantId: string; createdById: string; deletedAt: Date | null; number: number }[],
  /** Documents sent on WhatsApp: the full argument list of each call. */
  documents: [] as unknown[][],
  /** Quote PDFs rendered. */
  rendered: [] as string[],
  /** The document send failing (the texts still go), and the renderer producing nothing. */
  documentFails: false,
  noPdf: false,
  onConfirm: null as (() => void) | null,
};
const ASK_LIMIT = 60;

function matches(row: object, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Where[]).some((alt) => matches(row, alt));
    const value = (row as Record<string, unknown>)[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("lt" in cond) return value instanceof Date && value < (cond as { lt: Date }).lt;
      if ("in" in cond) return (cond as { in: unknown[] }).in.includes(value);
      if ("not" in cond) return (cond as { not: unknown }).not === null ? value !== null : value !== (cond as { not: unknown }).not;
      if ("gt" in cond) return value instanceof Date && value > (cond as { gt: Date }).gt;
    }
    return value === cond;
  });
}
const linkTable = {
  findFirst: async ({ where }: { where: Where }) => (state.queries.push(where), state.links.find((l) => matches(l, where)) ?? null),
  findMany: async ({ where }: { where: Where }) => (state.queries.push(where), state.links.filter((l) => matches(l, where))),
  updateMany: async ({ where, data }: { where: Where; data: Partial<Link> }) => {
    state.queries.push(where);
    state.writes.push(data);
    const hit = state.links.filter((l) => matches(l, where));
    for (const l of hit) Object.assign(l, data);
    // The real table's unique (tenantId, waId): two rows on one number throws.
    const held = state.links.filter((l) => l.waId).map((l) => `${l.tenantId}:${l.waId}`);
    if (new Set(held).size !== held.length) throw new Error("unique (tenantId, waId) violated");
    return { count: hit.length };
  },
};
const turnTable = {
  findFirst: async ({ where }: { where: Where }) => state.turns.find((t) => matches(t, where)) ?? null,
  findMany: async ({ where, take, distinct }: { where: Where; take?: number; distinct?: string[] }) => {
    const rows = state.turns.filter((t) => matches(t, where)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const kept = distinct?.includes("userId") ? rows.filter((t, i) => rows.findIndex((o) => o.userId === t.userId) === i) : rows;
    return kept.slice(0, take);
  },
  updateMany: async ({ where, data }: { where: Where; data: Partial<Turn> }) => {
    const hit = state.turns.filter((t) => matches(t, where));
    for (const t of hit) Object.assign(t, data);
    return { count: hit.length };
  },
};
const fakeDb = {
  // Quotes as the PDF sender looks them up: by id, workspace, who created it, not deleted.
  quote: { findFirst: async ({ where }: { where: Where }) => state.quotes.find((q) => matches(q, where)) ?? null },
  assistantTurn: turnTable,
  assistantPhoneLink: linkTable,
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ assistantPhoneLink: linkTable, $executeRaw: async () => 0 }),
};

type Loader = (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
const fromLib = (parent: { filename?: string } | undefined) =>
  (parent?.filename ?? "").replace(/\\/g, "/").endsWith("src/lib/assistantWhatsApp.ts");

loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only") return {};
  if (fromLib(parent)) {
    switch (request) {
      case "./db": return { basePrisma: fakeDb };
      case "./settings": return { getSetting: async (key: string) => (key === "ASSISTANT_WHATSAPP" ? state.switch : key === "ASSISTANT_WHATSAPP_TEMPLATE" ? state.template : null) };
      case "./tenantScope": return { currentTenantScope: () => state.scope };
      case "./whatsapp": return {
        waDigits: (p: string) => { const d = p.replace(/\D/g, ""); return d.startsWith("0") ? "27" + d.slice(1) : d; },
        sendWhatsAppText: async (to: string, text: string) => {
          // The real one's wording for Meta's 131047.
          if (state.metaRefuses) return { ok: false, error: "Outside the 24-hour reply window — the customer must message you first (or use an approved template from WhatsApp Manager)." };
          // WhatsApp unreachable from the Nth text of this test onwards (the real one's wording).
          if (state.textFailsFrom !== null && state.sent.length >= state.textFailsFrom) return { ok: false, error: "Could not reach WhatsApp (timed out)" };
          state.sent.push({ to, text });
          // What a send costs, or what happens while it is in flight.
          state.onSend?.();
          return { ok: true };
        },
        sendWhatsAppTemplate: async (to: string, name: string, language: string) => {
          state.templateTries++;
          if (state.templateFails === "throws") throw new Error("socket hang up");
          if (state.templateFails) return { ok: false, error: state.templateFails };
          state.templatesSent.push({ to, name, language });
          return { ok: true };
        },
        sendWhatsAppButtons: async (to: string, text: string, buttons: { title: string }[]) => {
          state.sent.push({ to, text, buttons: buttons.map((b) => b.title) }); return { ok: true };
        },
        // Every argument kept: a fourth (`record`) would file the send on a customer's timeline.
        sendWhatsAppDocument: async (...args: unknown[]) => {
          if (state.documentFails) return { ok: false, error: "Could not reach WhatsApp (timed out)" };
          state.documents.push(args);
          return { ok: true };
        },
        fetchWhatsAppMedia: async () => { state.mediaFetched++; return state.media ?? { buffer: Buffer.from("x"), contentType: "audio/ogg" }; },
        // Recorded with what had been sent by then, to show it comes BEFORE the answer.
        showWhatsAppTyping: async (id: string | null | undefined) => { if (id) state.typing.push({ id, sentBefore: state.sent.length }); },
        // A number on a customer record in this workspace (the real one scopes by tenant).
        matchByPhone: async (digits: string) => ({
          contactId: state.customers.has(digits) ? "contact-1" : null,
          leadId: null,
          ambiguous: state.ambiguous.has(digits),
        }),
      };
      case "./quotePdf": return { quotePdf: async (quoteId: string) => { state.rendered.push(quoteId); return state.noPdf ? null : Buffer.from("%PDF-1.7 quote"); } };
      case "./transcribe": return { transcribeVoice: async () => "what is overdue today" };
      case "./crmAssistant": return {
        askCrm: async (user: { id: string }, question: string, _page: unknown, opts: { source?: string; images?: string[]; proposeTasks?: boolean | "saved" }) => {
          state.asked.push({ userId: user.id, question, source: opts.source });
          state.askedImages.push(opts.images ?? []);
          state.proposeTasks.push(opts.proposeTasks ?? false);
          // As the real one: proposals come back only when the caller said what it will do with them.
          if (opts.proposeTasks && state.proposals.length) {
            return { ok: true, answer: "Set up for you to confirm.", rows: [], tools: [], learned: 0, actions: state.proposals, choices: [] };
          }
          return { ok: true, answer: "Two follow-ups are overdue.", rows: [], tools: [], learned: 0, actions: [], choices: ["Show them"] };
        },
      };
      // The confirm step itself is proved in assistantWhatsAppConfirm.test.ts; here, only WHEN it is reached.
      case "./assistantWhatsAppConfirm": return {
        confirmingOnWhatsAppOn: async () => state.confirmOn,
        offerConfirmations: async (tenantId: string, userId: string, waId: string, cards: { kind: string }[]) => {
          state.offered.push({ tenantId, userId, waId, kinds: cards.map((c) => c.kind), sentBefore: state.sent.length });
        },
        confirmFromWhatsApp: async (tenantId: string, user: { id: string }, waId: string, pendingId: string) => {
          state.confirmed.push({ tenantId, userId: user.id, waId, pendingId });
          // What the real confirm step leaves behind for a built quote: a queued update naming the quote.
          state.onConfirm?.();
        },
      };
      case "./assistantUser": return {
        assistantUserFor: async (id: string) => (state.members.has(id) ? { id, name: id, email: `${id}@x`, role: "staff" } : null),
        // The person's one ask limit, shared with every channel (60 an hour).
        assistantAskAllowed: async (id: string) => {
          const n = (state.asks.get(id) ?? 0) + 1;
          state.asks.set(id, n);
          return n <= ASK_LIMIT;
        },
        ASK_LIMIT_MESSAGE: "You've asked a lot in the last hour — give it a few minutes and try again.",
        assistantImageAllowed: async () => state.imageAllowed,
      };
      case "./userSecurity": return {
        // Strict: a failed read throws (no version-0 fallback).
        readUserSecurityStateStrict: async (id: string) => {
          if (state.securityDown) throw new Error("database unavailable");
          return { sessionVersion: state.sessionVersions.get(id) ?? 1, disabledAt: null };
        },
      };
      case "./audit": return { logAudit: async (e: { summary: string }) => { state.audits.push(e.summary); } };
      case "./errorLog": return { logError: async (...args: unknown[]) => { state.errors.push(args.map(String).join(" ")); } };
      case "./rateLimit": return {
        rateLimitKey: (scope: string, id: string) => `${scope}:${id}`,
        // As the real one: blocked once the count has reached the limit.
        checkRateLimit: async (key: string) => ({ allowed: (state.guesses.get(key) ?? 0) < LINK_GUESS_POLICY.limit }),
        registerRateLimitAttempt: async (key: string, policy: { limit: number }) => {
          const n = (state.guesses.get(key) ?? 0) + 1;
          state.guesses.set(key, n);
          return { allowed: n < policy.limit };
        },
      };
    }
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const require_ = createRequire(import.meta.url);
const { handleStaffWhatsApp, hashLinkCode, sendUpdatesToLinkedPhone, sweepWaitingUpdates } = require_("../src/lib/assistantWhatsApp.ts") as typeof import("../src/lib/assistantWhatsApp");

const STAFF = "27821234567";
const CUSTOMER = "27839990000";
const soon = () => new Date(Date.now() + LINK_CODE_TTL_MS);

function pending(userId: string, codeText: string, expires = soon(), tenantId = "t1"): Link {
  // Issued under the account's sign-in version at that moment, as startWhatsAppLink does.
  const row: Link = { id: `pending-${tenantId}-${userId}`, tenantId, userId, waId: null, codeHash: hashLinkCode(tenantId, userId, codeText), codeExpiresAt: expires, verifiedAt: null, sessionVersion: state.sessionVersions.get(userId) ?? 1 };
  state.links.push(row);
  return row;
}
function verified(userId: string, waId: string, tenantId = "t1"): Link {
  const row: Link = { id: `linked-${tenantId}-${userId}`, tenantId, userId, waId, codeHash: null, codeExpiresAt: null, verifiedAt: new Date(), sessionVersion: 1, updatesOnWhatsApp: true, nudgedAt: null, nudgeFailedAt: null, lastInboundAt: null };
  state.links.push(row);
  return row;
}
const HOUR = 3_600_000;
/** A scheduled briefing (or watch alert) saved to u1's history `hoursAgo` hours ago, not yet on their phone. */
function waitingTurn(id: string, hoursAgo = 0, source = "schedule", userId = "u1"): Turn {
  const row: Turn = { id, tenantId: "t1", userId, source, question: `Question ${id}`, answer: `Answer ${id}`, createdAt: new Date(Date.now() - hoursAgo * HOUR), whatsappSentAt: null, whatsappClaimedAt: null, whatsappPartsSent: 0 };
  state.turns.push(row);
  return row;
}

beforeEach(() => {
  state.scope = { tenantId: "t1", system: false };
  state.queries = [];
  state.writes = [];
  state.switch = "on";
  state.links = [];
  state.members = new Set(["u1", "u2"]);
  state.sent = [];
  state.asked = [];
  state.mediaFetched = 0;
  state.typing = [];
  state.media = null;
  state.imageAllowed = true;
  state.askedImages = [];
  state.confirmOn = false;
  state.proposals = [];
  state.proposeTasks = [];
  state.offered = [];
  state.confirmed = [];
  state.errors = [];
  state.audits = [];
  state.guesses = new Map();
  state.asks = new Map();
  state.customers = new Set();
  state.ambiguous = new Set();
  state.sessionVersions = new Map();
  state.securityDown = false;
  state.turns = [];
  state.template = null;
  state.templatesSent = [];
  state.metaRefuses = false;
  state.textFailsFrom = null;
  state.templateFails = null;
  state.templateTries = 0;
  state.quotes = [];
  state.documents = [];
  state.rendered = [];
  state.documentFails = false;
  state.noPdf = false;
  state.onConfirm = null;
  state.onSend = null;
});

/* ── the gate, behaviourally ───────────────────────────────────────────── */

test("switch off → false, even for a linked number with a valid question", async () => {
  verified("u1", STAFF);
  for (const off of [null, "off", "true", "ON"]) {
    state.switch = off;
    assert.equal(await handleStaffWhatsApp(STAFF, { text: "what's overdue?" }), false, String(off));
  }
  assert.equal(state.asked.length, 0);
  assert.equal(state.sent.length, 0);
});

test("only a REAL workspace scope: none, system or tenantless → false, and no link is even looked up", async () => {
  verified("u1", STAFF);
  pending("u2", "123456");
  for (const scope of [undefined, { tenantId: null, system: true }, { tenantId: "t1", system: true }, { tenantId: null, system: false }] as Scope[]) {
    state.scope = scope;
    assert.equal(await handleStaffWhatsApp(STAFF, { text: "hi" }), false, JSON.stringify(scope));
    assert.equal(await handleStaffWhatsApp(STAFF, { text: "DAX 123456" }), false, JSON.stringify(scope));
    assert.equal(await handleStaffWhatsApp(STAFF, { voiceMediaId: "m1" }), false, JSON.stringify(scope));
  }
  assert.equal(state.queries.length, 0, "AssistantPhoneLink is never read outside a tenant scope");
  assert.equal(state.writes.length, 0);
  assert.equal(state.mediaFetched, 0);
  assert.equal(state.links[1].waId, null);
});

test("every link read and write names THIS workspace explicitly — and never moves a row to another", async () => {
  verified("u1", "27820000001", "t2"); // someone else's workspace, same table
  const theirPending = pending("u1", "123456", soon(), "t2");
  pending("u1", "123456");
  verified("u2", STAFF);
  await handleStaffWhatsApp(STAFF, { text: "DAX 123456" });
  await handleStaffWhatsApp(STAFF, { text: "anything new?" });
  await handleStaffWhatsApp(CUSTOMER, { text: "hello" });
  assert.ok(state.queries.length >= 4);
  for (const where of state.queries) assert.equal(where.tenantId, "t1", JSON.stringify(where));
  for (const data of state.writes) assert.ok(!("tenantId" in data), "a write never changes a row's workspace");
  assert.ok(theirPending.codeHash, "the other workspace's pending code is untouched");
  assert.equal(state.links.filter((l) => l.tenantId === "t2" && l.waId === STAFF).length, 0);
});

test("an unknown number → false, and its voice note is never fetched", async () => {
  verified("u1", STAFF);
  assert.equal(await handleStaffWhatsApp(CUSTOMER, { text: "Is the 4-seater in stock?" }), false);
  assert.equal(await handleStaffWhatsApp(CUSTOMER, { voiceMediaId: "media-1" }), false);
  assert.equal(state.mediaFetched, 0, "a customer's voice note must not be downloaded or transcribed here");
  assert.equal(state.asked.length, 0);
});

test("a linked number in ANOTHER workspace is not staff here", async () => {
  verified("u1", STAFF, "t2");
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "pipeline?" }), false);
});

test("an unverified or expired code → false, and nothing is linked", async () => {
  const row = pending("u1", "123456", new Date(Date.now() - 1000));
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "DAX 123456" }), false, "expired");
  assert.equal(row.waId, null);
  row.codeExpiresAt = soon();
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "DAX 654321" }), false, "wrong code");
  assert.equal(row.waId, null);
  assert.equal(row.verifiedAt, null);
  // A code issued in another workspace is not a code here.
  state.links = [];
  pending("u1", "123456", soon(), "t2");
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "DAX 123456" }), false, "other workspace");
  assert.equal(state.links[0].waId, null);
  assert.equal(state.sent.length, 0, "a failed code gets no reply from DAX — it goes on as a customer message");
});

test("a matching code links exactly the SENDING number, to that person, and is used up", async () => {
  const mine = pending("u1", "123456");
  const theirs = pending("u2", "999999");
  assert.equal(await handleStaffWhatsApp("+27 82 123 4567", { text: "  dax 123456 " }), true);
  assert.equal(mine.waId, STAFF);
  assert.ok(mine.verifiedAt instanceof Date);
  assert.equal(mine.codeHash, null);
  assert.equal(mine.codeExpiresAt, null);
  assert.equal(theirs.waId, null, "someone else's pending code is untouched");
  assert.ok(theirs.codeHash);
  assert.match(state.sent[0].text, /^✅ Linked — I'm /);
  assert.equal(state.sent[0].to, STAFF);
  assert.equal(mine.refusedReason, null, "a link clears any earlier refusal");
  assert.equal(linkRefusalText("something else"), null, "an unknown reason shows nothing");
  // A new code clears it too, and the page shows it: the reason must not outlive the attempt it describes.
  assert.match(code("src/app/actions/assistantWhatsApp.ts"), /update: \{ codeHash, codeExpiresAt, waId: null, verifiedAt: null, refusedReason: null,/);
  assert.match(code("src/app/(app)/assistant/page.tsx"), /refused: linkRefusalText\(link\?\.refusedReason\)/);
  // Used: the same code again links nothing new.
  assert.equal(await handleStaffWhatsApp(CUSTOMER, { text: "DAX 123456" }), false);
  assert.equal(mine.waId, STAFF);
});

test("a customer's number is never linked, even with a valid code — and the code is burnt", async () => {
  for (const kind of ["customers", "ambiguous"] as const) {
    state.links = [];
    state.sent = [];
    state.customers = new Set();
    state.ambiguous = new Set();
    state[kind].add(CUSTOMER);
    const row = pending("u1", "123456");
    assert.equal(await handleStaffWhatsApp(CUSTOMER, { text: "DAX 123456" }), false, kind);
    assert.equal(row.waId, null, `${kind}: not linked`);
    assert.equal(row.verifiedAt, null);
    assert.equal(row.codeHash, null, `${kind}: the code can't be retried`);
    assert.equal(state.sent.length, 0, "no DAX reply to a customer's phone");
    // The person who asked is told on the Ask page instead — the phone never is.
    assert.equal(row.refusedReason, "customer_number", `${kind}: the reason is kept for the page`);
    assert.match(linkRefusalText(row.refusedReason) ?? "", /saved on a customer or an open lead/);
    assert.match(state.audits.at(-1) ?? "", /Refused to link WhatsApp •••000: that number is on a customer record/);
    // …and it is still not staff afterwards.
    assert.equal(await handleStaffWhatsApp(CUSTOMER, { text: "what's in the pipeline?" }), false);
    assert.equal(state.asked.length, 0);
  }
});

test("an already-linked number that becomes a customer's is re-checked on EVERY message", async () => {
  for (const kind of ["customers", "ambiguous"] as const) {
    state.links = [];
    state.sent = [];
    state.asked = [];
    state.customers = new Set();
    state.ambiguous = new Set();
    const row = verified("u1", STAFF);
    assert.equal(await handleStaffWhatsApp(STAFF, { text: "pipeline?" }), true, `${kind}: staff while not a customer`);
    assert.equal(state.asked.length, 1);
    // The number is later saved on a customer record (or a lead), or becomes ambiguous.
    state[kind].add(STAFF);
    state.sent = [];
    assert.equal(await handleStaffWhatsApp(STAFF, { text: "pipeline?" }), false, `${kind}: now a customer's number — customer path`);
    assert.equal(state.asked.length, 1, "no CRM answer was produced");
    assert.equal(state.sent.length, 0, "nothing was sent to that phone");
    assert.equal(row.waId, null, "the link is cleared");
    assert.match(state.audits.at(-1) ?? "", /•••567 unlinked from the assistant: that number is now on a customer record/);
    // Voice notes too: never fetched once the number is a customer's.
    state.mediaFetched = 0;
    assert.equal(await handleStaffWhatsApp(STAFF, { voiceMediaId: "m1" }), false);
    assert.equal(state.mediaFetched, 0);
  }
  const lib = code("src/lib/assistantWhatsApp.ts");
  const handler = lib.slice(lib.indexOf("export async function handleStaffWhatsApp"), lib.indexOf("async function verifyLinkCode"));
  assert.ok(handler.indexOf("await matchByPhone(waId)") < handler.indexOf("await assistantUserFor(link.userId)"), "checked before anything is answered");
  assert.ok(handler.indexOf("await matchByPhone(waId)") < handler.indexOf("fetchWhatsAppMedia("), "and before a voice note is fetched");
});

test("one number can't be linked to two people: the newer proof takes it over", async () => {
  const old = verified("u2", STAFF);
  const fresh = pending("u1", "123456");
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "DAX 123456" }), true);
  assert.equal(fresh.waId, STAFF);
  assert.equal(old.waId, null);
  assert.equal(old.verifiedAt, null);
  assert.equal(state.links.filter((l) => l.waId === STAFF).length, 1);
});

test("a code that matches two people at once links neither", async () => {
  const a = pending("u1", "123456");
  const b = pending("u2", "123456");
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "DAX 123456" }), false);
  assert.equal(a.waId, null);
  assert.equal(b.waId, null);
});

test("guessing is cut off: after the limit even the right code isn't compared", async () => {
  const row = pending("u1", "123456");
  for (let i = 0; i < LINK_GUESS_POLICY.limit; i++) await handleStaffWhatsApp(CUSTOMER, { text: `DAX ${String(i).padStart(6, "0")}` });
  assert.equal(await handleStaffWhatsApp(CUSTOMER, { text: "DAX 123456" }), false);
  assert.equal(row.waId, null);
});

test("guessing is counted before comparing, and capped across the workspace too", async () => {
  const row = pending("u1", "123456");
  // Many numbers, few guesses each: the workspace cap still stops them.
  for (let i = 0; i < LINK_GUESS_WORKSPACE_POLICY.limit; i++) {
    await handleStaffWhatsApp(`2783000${String(i).padStart(4, "0")}`, { text: `DAX ${String(i).padStart(6, "0")}` });
  }
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "DAX 123456" }), false, "the right code from a fresh number, after the workspace cap");
  assert.equal(row.waId, null);
  const lib = code("src/lib/assistantWhatsApp.ts");
  const verify = lib.slice(lib.indexOf("async function verifyLinkCode"));
  assert.ok(verify.indexOf("registerRateLimitAttempt(") < verify.indexOf("sameHash("), "counted before any comparison");
  assert.doesNotMatch(lib, /checkRateLimit\(/, "no check-then-register race");
});

test("a linked phone dies with the account's other sign-ins — password reset, sign out everywhere", async () => {
  const row = verified("u1", STAFF);
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "pipeline?" }), true, "linked under version 1");
  state.sessionVersions.set("u1", 2); // a reset / revoke-all bumps it
  state.asked = [];
  state.sent = [];
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "pipeline?" }), true, "handled once: told why, never answered");
  assert.equal(state.asked.length, 0, "no answer under the old link");
  assert.equal(row.waId, null, "the link is cleared");
  assert.equal(row.sessionVersion, null);
  assert.match(state.sent[0]?.text ?? "", /no longer linked to the assistant/);
  assert.doesNotMatch(state.sent[0]?.text ?? "", /overdue|pipeline|R\d/, "no data in the notice");
  assert.match(state.audits.at(-1) ?? "", /•••567 unlinked from the assistant: the account's sign-ins were reset/);
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "pipeline?" }), false, "after that: nobody's number");
  // A fresh code, issued under the new version, links under it.
  state.links = [];
  const fresh = pending("u1", "654321");
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "DAX 654321" }), true);
  assert.equal(fresh.sessionVersion, 2);
});

test("the sign-in check fails CLOSED: a database error is retried, never read as 'still valid'", async () => {
  verified("u1", STAFF);
  state.securityDown = true;
  await assert.rejects(handleStaffWhatsApp(STAFF, { text: "pipeline?" }), /database unavailable/);
  assert.equal(state.asked.length, 0);
});

test("the 'no longer linked' notice is sent once, and never wipes a link made since", async () => {
  const row = verified("u1", STAFF);
  state.sessionVersions.set("u1", 2);
  // Two deliveries read the same stale link; only the first clears it and speaks.
  const [a, b] = await Promise.all([
    handleStaffWhatsApp(STAFF, { text: "one" }),
    handleStaffWhatsApp(STAFF, { text: "two" }),
  ]);
  assert.deepEqual([a, b].sort(), [false, true]);
  assert.equal(state.sent.filter((s) => /no longer linked/.test(s.text)).length, 1);
  assert.equal(row.waId, null);
  const lib = code("src/lib/assistantWhatsApp.ts");
  assert.match(lib, /where: \{ id: link\.id, tenantId, waId, sessionVersion: link\.sessionVersion \}/);
  assert.match(lib, /if \(cleared\.count !== 1\) return false;/);
});

test("a code is stamped with the CALLER's session version — a pre-reset session gets a useless code", () => {
  const actions = code("src/app/actions/assistantWhatsApp.ts");
  const start = actions.slice(actions.indexOf("export async function startWhatsAppLink"));
  assert.match(start, /const sessionVersion = await callerSessionVersion\(\);/);
  assert.match(start, /if \(sessionVersion === null \|\| !security \|\| security\.sessionVersion !== sessionVersion\)/);
  assert.match(actions, /const session = await verifySession\(token\);/, "read from the signed cookie, not trusted from the client");
});

test("Sessions & devices: the linked phone shows next to the devices, and 'Sign out all' ends it", () => {
  const page = code("src/app/(app)/settings/sessions/page.tsx");
  assert.match(page, /where: \{ tenantId, waId: \{ not: null \}, verifiedAt: \{ not: null \} \}/);
  assert.match(page, /onConfirm=\{unlinkWhatsAppFor\.bind\(null, u\.id\)\}/);
  const sessions = code("src/app/actions/sessions.ts");
  const all = sessions.slice(sessions.indexOf("export async function revokeAllForUser"));
  assert.ok(all.indexOf("mayManageSessionsOf(") < all.indexOf("assistantPhoneLink.deleteMany"), "same gate as signing the devices out");
  assert.match(all, /await prisma\.assistantPhoneLink\.deleteMany\(\{ where: \{ userId \} \}\);/);
});

test("a code asked for BEFORE a reset is burnt, not redeemed after it", async () => {
  const row = pending("u1", "123456"); // issued under version 1 (e.g. from a stolen session)
  state.sessionVersions.set("u1", 2); // the victim resets their password
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "DAX 123456" }), false);
  assert.equal(row.waId, null, "not linked");
  assert.equal(row.codeHash, null, "the code is burnt");
  assert.equal(state.sent.length, 0);
});

test("a blocked number doesn't keep the workspace's guess counter full", async () => {
  for (let i = 0; i < 40; i++) await handleStaffWhatsApp(CUSTOMER, { text: `DAX ${String(i).padStart(6, "0")}` });
  const workspaceKey = [...state.guesses.keys()].find((k) => k.startsWith("assistant-wa-guess-ws:"));
  assert.ok((state.guesses.get(workspaceKey ?? "") ?? 0) < LINK_GUESS_WORKSPACE_POLICY.limit, "colleagues can still link");
  const mine = pending("u2", "777777");
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "DAX 777777" }), true);
  assert.equal(mine.waId, STAFF);
});

test("the owner can unlink anyone's phone in this workspace; nobody else can", () => {
  const actions = code("src/app/actions/assistantWhatsApp.ts");
  const ownerUnlink = actions.slice(actions.indexOf("export async function unlinkWhatsAppFor"), actions.indexOf("export async function unlinkMyWhatsApp"));
  assert.match(ownerUnlink, /const owner = await requireTenantOwner\(\);/);
  assert.match(ownerUnlink, /deleteMany\(\{ where: \{ tenantId, userId: String\(userId \?\? ""\) \} \}\)/);
  assert.match(code("src/app/(app)/settings/assistant/page.tsx"), /onConfirm=\{unlinkWhatsAppFor\.bind\(null, p\.userId\)\}/);
  assert.match(code("src/app/api/webhooks/whatsapp/route.ts"), /export const maxDuration = 300;/);
});

test("a person who lost access is no longer staff — the link stays for the owner to see", async () => {
  const row = verified("u1", STAFF);
  state.members.delete("u1");
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "pipeline?" }), false);
  assert.equal(row.waId, STAFF);
  // …and they can't link a new phone either.
  state.links = [];
  pending("u1", "123456");
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "DAX 123456" }), false);
});

test("a linked staff member is answered on WhatsApp, as themselves, with buttons that fit", async () => {
  verified("u1", STAFF);
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "  what's overdue?  " }), true);
  assert.deepEqual(state.asked, [{ userId: "u1", question: "what's overdue?", source: "whatsapp" }]);
  assert.deepEqual(state.sent, [{ to: STAFF, text: "Two follow-ups are overdue.", buttons: ["Show them"] }]);
  // A tapped button arrives as its title — the next question.
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "Show them" }), true);
  assert.equal(state.asked[1].question, "Show them");
  // A voice note from staff is fetched and transcribed — only now.
  assert.equal(await handleStaffWhatsApp(STAFF, { voiceMediaId: "m1" }), true);
  assert.equal(state.mediaFetched, 1);
  assert.equal(state.asked[2].question, "what is overdue today");
});

test("'typing…' shows while DAX works it out — for staff only, before the answer, and never for a customer", async () => {
  verified("u1", STAFF);
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "what's overdue?" }, "wamid.ASK1"), true);
  assert.deepEqual(state.typing, [{ id: "wamid.ASK1", sentBefore: 0 }], "shown against their message, before anything is sent");
  assert.equal(state.sent.length, 1, "the answer still goes");
  // A voice note too.
  assert.equal(await handleStaffWhatsApp(STAFF, { voiceMediaId: "m1" }, "wamid.ASK2"), true);
  assert.equal(state.typing[1]?.id, "wamid.ASK2");
  // No message id (an older caller): the answer goes, with no indicator.
  state.typing = [];
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "pipeline?" }), true);
  assert.deepEqual(state.typing, []);

  // A CUSTOMER's chat never shows it, and their message is never marked read by us: an unknown
  // number, a number that has landed on a customer record, a link code that is refused, the
  // switch being off, a person over their limit.
  assert.equal(await handleStaffWhatsApp(CUSTOMER, { text: "how much is the scooter?" }, "wamid.CUST"), false);
  state.customers.add(STAFF);
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "pipeline?" }, "wamid.NOWCUST"), false);
  state.customers.clear();
  state.links = [];
  state.customers.add(CUSTOMER);
  pending("u1", "123456");
  assert.equal(await handleStaffWhatsApp(CUSTOMER, { text: "DAX 123456" }, "wamid.CODE"), false);
  state.customers.clear();
  state.links = [];
  verified("u1", STAFF);
  state.switch = "off";
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "pipeline?" }, "wamid.OFF"), false);
  state.switch = "on";
  state.asks.set("u1", ASK_LIMIT);
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "pipeline?" }, "wamid.LIMIT"), true);
  assert.deepEqual(state.typing, [], "none of these showed typing");

  // It is started after every staff check and is the only caller; and it can never flag the connection or throw.
  const lib = code("src/lib/assistantWhatsApp.ts");
  const handler = lib.slice(lib.indexOf("export async function handleStaffWhatsApp"), lib.indexOf("async function sendVoiceAnswer"));
  assert.ok(handler.indexOf("assistantAskAllowed(user.id)") < handler.indexOf("showWhatsAppTyping(messageId)"));
  assert.ok(handler.indexOf("showWhatsAppTyping(messageId)") < handler.indexOf("await askCrm("));
  assert.equal(lib.match(/showWhatsAppTyping\(/g)?.length, 1);
  const wa = code("src/lib/whatsapp.ts");
  const typing = wa.slice(wa.indexOf("export async function showWhatsAppTyping"), wa.indexOf("export async function sendWhatsAppImage"));
  assert.match(typing, /status: "read", message_id: messageId, typing_indicator: \{ type: "text" \}/);
  assert.match(typing, /AbortSignal\.timeout\(TYPING_TIMEOUT_MS\)/);
  assert.doesNotMatch(typing, /noteWhatsAppOutcome|throw /, "a declined indicator must not mark the connection broken, or throw");
  for (const file of ["src/lib/bot.ts", "src/lib/flowRun.ts", "src/app/api/webhooks/whatsapp/route.ts"]) {
    assert.doesNotMatch(code(file), /showWhatsAppTyping/, `${file}: the customer chatbot does not use it`);
  }
});

test("a task asked for on WhatsApp is never thrown away: saved for the CRM by default, a Confirm button when the owner allows it; a tapped Confirm is reached only as verified staff", async () => {
  const CONFIRM = "daxc:cmpendingpendingpendingpe";
  verified("u1", STAFF);
  state.proposals = [{ kind: "note", title: "Add a note to Anna's lead" }];

  // Switch off (the default): the assistant is told its tasks will be SAVED, and what it
  // proposed is handed on — the confirm module, which knows the switch is off, keeps it for the CRM.
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "note on Anna: wants white" }), true);
  assert.deepEqual(state.proposeTasks, ["saved"]);
  assert.deepEqual(state.offered.map((o) => o.kinds), [["note"]], "handed on, not dropped");

  // Switch on: asked for tasks, and what it proposed is offered — to this person, in this workspace, AFTER the answer.
  state.confirmOn = true;
  state.sent = [];
  state.offered = [];
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "note on Anna: wants white" }), true);
  assert.equal(state.proposeTasks.at(-1), true);
  assert.deepEqual(state.offered, [{ tenantId: "t1", userId: "u1", waId: STAFF, kinds: ["note"], sentBefore: 1 }]);

  // A tapped Confirm: handed to the confirm step as this person; nothing is asked, and it is not counted as a question.
  const asked = state.asked.length;
  const asks = state.asks.get("u1");
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "Confirm", choiceId: CONFIRM }), true);
  assert.deepEqual(state.confirmed, [{ tenantId: "t1", userId: "u1", waId: STAFF, pendingId: "cmpendingpendingpendingpe" }]);
  assert.equal(state.asked.length, asked);
  assert.equal(state.asks.get("u1"), asks);
  // An ordinary quick-reply button (dax:0) is still just the next question.
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "Show them", choiceId: "dax:0" }), true);
  assert.equal(state.confirmed.length, 1);
  assert.equal(state.asked.at(-1)?.question, "Show them");

  // NEVER for anyone who is not verified staff right now — the same button id from:
  state.confirmed = [];
  assert.equal(await handleStaffWhatsApp(CUSTOMER, { text: "Confirm", choiceId: CONFIRM }), false, "an unknown number");
  state.customers.add(STAFF);
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "Confirm", choiceId: CONFIRM }), false, "a number now on a customer record");
  state.customers.clear();
  state.links = [];
  verified("u1", STAFF);
  state.sessionVersions.set("u1", 2);
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "Confirm", choiceId: CONFIRM }), true, "sign-ins reset: told once, unlinked");
  state.sessionVersions.set("u1", 1);
  state.links = [];
  verified("u1", STAFF);
  state.members.delete("u1");
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "Confirm", choiceId: CONFIRM }), false, "no longer a member");
  state.members.add("u1");
  state.switch = "off";
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "Confirm", choiceId: CONFIRM }), false, "the assistant's WhatsApp switch off");
  assert.deepEqual(state.confirmed, [], "none of these reached the confirm step");

  // In the code: the confirm branch sits after every staff check, and the webhook passes the button's id.
  const lib = code("src/lib/assistantWhatsApp.ts");
  const handler = lib.slice(lib.indexOf("export async function handleStaffWhatsApp"), lib.indexOf("async function sendVoiceAnswer"));
  const at = handler.indexOf("await confirmFromWhatsApp(tenantId, user, waId, pendingId)");
  for (const before of ["readUserSecurityStateStrict(link.userId)", "await matchByPhone(waId)", "await assistantUserFor(link.userId)"]) {
    assert.ok(handler.indexOf(before) > -1 && handler.indexOf(before) < at, before);
  }
  assert.ok(at < handler.indexOf("assistantAskAllowed(user.id)"));
  assert.match(code("src/app/api/webhooks/whatsapp/route.ts"), /handleStaffWhatsApp\(from, \{ text: title, choiceId: id \}, message\.id\)/);
});

test("questions are capped at 500 characters and by the person's ONE ask limit", async () => {
  verified("u1", STAFF);
  await handleStaffWhatsApp(STAFF, { text: "x".repeat(900) });
  assert.equal(state.asked[0].question.length, 500);
  for (let i = 1; i < ASK_LIMIT + 3; i++) await handleStaffWhatsApp(STAFF, { text: `q${i}` });
  assert.equal(state.asked.length, ASK_LIMIT, "answered up to the shared limit, then refused");
  assert.match(state.sent.at(-1)!.text, /You've asked a lot in the last hour/);
  // Over the limit, a voice note is not even downloaded.
  const fetched = state.mediaFetched;
  assert.equal(await handleStaffWhatsApp(STAFF, { voiceMediaId: "m2" }), true);
  assert.equal(state.mediaFetched, fetched);
  // It is the shared per-person limit, not a WhatsApp-only counter.
  const lib = code("src/lib/assistantWhatsApp.ts");
  assert.match(lib, /if \(!\(await assistantAskAllowed\(user\.id\)\)\) \{\s*await sendPlan\(waId, \{ texts: \[ASK_LIMIT_MESSAGE\]/);
  assert.doesNotMatch(lib, /assistant-wa-ask/);
});

test("nothing logged or audited carries the message, the answer or the number", async () => {
  pending("u1", "123456");
  await handleStaffWhatsApp(STAFF, { text: "DAX 123456" });
  await handleStaffWhatsApp(STAFF, { text: "secret question about Mrs Jacobs" });
  const logged = [...state.errors, ...state.audits].join("\n");
  for (const leak of [STAFF, "4567", "Jacobs", "overdue", "123456"]) assert.ok(!logged.includes(leak), leak);
  assert.match(state.audits.join("\n"), /•••567/, "the audit shows the number masked");
  // And in source: every logError in the module passes a fixed reason, never a variable message.
  const lib = code("src/lib/assistantWhatsApp.ts");
  const calls = (lib.match(/logError\(/g) ?? []).length;
  const fixed = (lib.match(/logError\("assistant-whatsapp", "[^"]+"(, error instanceof Error \? error\.name : "unknown")?\)/g) ?? []).length;
  assert.ok(calls > 0);
  assert.equal(fixed, calls, "a logError call passes something other than a fixed reason");
});

/* ── the code ──────────────────────────────────────────────────────────── */

test("the code is six digits, parsed strictly, and stored only as a workspace-and-person-bound hash", () => {
  assert.equal(formatLinkCode(42), "000042");
  assert.equal(formatLinkCode(999999), "999999");
  assert.equal(parseLinkCode("DAX 012345"), "012345");
  assert.equal(parseLinkCode("  dax   123456\n"), "123456");
  for (const bad of ["DAX 12345", "DAX 1234567", "DAX123456", "please DAX 123456", "DAX 123456 thanks", "123456", "", null]) {
    assert.equal(parseLinkCode(bad), null, String(bad));
  }
  assert.equal(linkCodeText("123456"), "DAX 123456");
  const h = hashLinkCode("t1", "u1", "123456");
  assert.equal(h, sha256(linkCodeHashInput("t1", "u1", "123456")));
  assert.notEqual(h, hashLinkCode("t2", "u1", "123456"), "another workspace");
  assert.notEqual(h, hashLinkCode("t1", "u2", "123456"), "another person");
  assert.ok(!h.includes("123456"));
  assert.equal(LINK_CODE_TTL_MS, 15 * 60 * 1000);
  assert.ok(LINK_CODE_POLICY.limit <= 6 && LINK_GUESS_POLICY.limit <= 6);
});

test("masking, the business number and the wa.me link", () => {
  assert.equal(maskWaId("27821234567"), "•••567");
  assert.equal(maskWaId(null), "•••");
  assert.deepEqual(businessNumberFromLabel("Denago Cape Town · +27 21 123 4567"), { display: "+27 21 123 4567", digits: "27211234567" });
  assert.equal(businessNumberFromLabel("Denago Cape Town"), null);
  assert.equal(businessNumberFromLabel(null), null);
  assert.equal(waMeLink("27211234567", "123456"), "https://wa.me/27211234567?text=DAX%20123456");
  assert.equal(waMeLink(null, "123456"), "https://wa.me/?text=DAX%20123456");
  assert.equal(whatsappSwitchOn("on"), true);
  assert.equal(whatsappSwitchOn(null), false);
});

test("long answers split under WhatsApp's 4096 limit, at a paragraph where it can", () => {
  const para = "a".repeat(3000);
  const parts = splitForWhatsApp(`${para}\n\n${para}\n\n${para}`);
  assert.equal(parts.length, 3);
  assert.ok(parts.every((p) => p.length <= 4096));
  assert.equal(parts.join(""), para.repeat(3));
  const solid = splitForWhatsApp("b".repeat(9000));
  assert.deepEqual(solid.map((p) => p.length), [4096, 4096, 808]);
  assert.deepEqual(splitForWhatsApp("short"), ["short"]);
});

test("quick replies: buttons only when they fit, else a numbered list", () => {
  assert.deepEqual(planWhatsAppReply("Hi", ["Yes", "No"]), { texts: [], buttons: { body: "Hi", titles: ["Yes", "No"] } });
  // Over 20 characters would be cut — and a cut title asks a different question.
  const long = planWhatsAppReply("Hi", ["Show me the overdue ones please"]);
  assert.equal(long.buttons, null);
  assert.equal(long.texts[0], "Hi\n\n1. Show me the overdue ones please");
  const four = planWhatsAppReply("Hi", ["A", "B", "C", "D"]);
  assert.equal(four.buttons, null);
  assert.match(four.texts[0], /4\. D$/);
  // An answer longer than a button body goes as text first.
  const big = planWhatsAppReply("z".repeat(2000), ["Yes"]);
  assert.equal(big.texts.length, 1);
  assert.deepEqual(big.buttons?.titles, ["Yes"]);
  assert.deepEqual(planWhatsAppReply("Done", []), { texts: ["Done"], buttons: null });
  assert.ok(planWhatsAppReply("  ", []).texts[0].length > 0, "never an empty message");
});

/* ── wiring ────────────────────────────────────────────────────────────── */

test("the route asks handleStaffWhatsApp FIRST and skips the inbox and the bot on a yes", () => {
  const route = code("src/app/api/webhooks/whatsapp/route.ts");
  const branch = (start: string, end: string) => route.slice(route.indexOf(start), route.indexOf(end, route.indexOf(start)));
  const text = branch('if (message.type === "text")', '} else if (message.type === "interactive")');
  const interactive = branch('} else if (message.type === "interactive")', '} else if (message.type === "image"');
  const audio = branch('} else if (message.type === "audio"', "await completeInboundBotEvent(claim)");
  for (const [name, body, call] of [
    // message.id: what "typing…" is shown against while the answer is worked out.
    ["text", text, "handleStaffWhatsApp(from, { text }, message.id)"],
    ["interactive", interactive, "handleStaffWhatsApp(from, { text: title, choiceId: id }, message.id)"],
    ["audio", audio, "handleStaffWhatsApp(from, { voiceMediaId: mediaId }, message.id)"],
  ] as const) {
    const at = body.indexOf(`if (await ${call}) return;`);
    assert.ok(at > -1, `${name}: must ask and return on a yes`);
    assert.ok(at < body.indexOf("recordInboundWhatsApp("), `${name}: before the customer inbox`);
    assert.ok(at < body.indexOf("runWhatsAppBot("), `${name}: before the chatbot`);
  }
  assert.ok(audio.indexOf("handleStaffWhatsApp(") < audio.indexOf("fetchWhatsAppMedia("), "the link is checked before any voice note is fetched");
  // The scope it relies on: a mapped business number binds a REAL tenant scope;
  // an unmapped one runs with none (dormant) or not at all (enforcing) — never a
  // system scope, which handleStaffWhatsApp would refuse anyway.
  const entry = code("src/lib/tenantScopeEntry.ts");
  const channel = entry.slice(entry.indexOf("export async function withChannelTenantScope"));
  assert.match(
    channel,
    /if \(tenantId\) return runInTenantScope\(\{ tenantId, system: false \}, fn\);\s*return tenantEnforcing\(\) \? onUnresolved\(\) : fn\(\);/,
  );
  assert.ok(route.indexOf('withChannelTenantScope("whatsapp", phoneNumberId') < route.indexOf("handleStaffWhatsApp(from"));
  // Inside the claimed handler, so a redelivery is not answered twice.
  assert.ok(route.indexOf("withInboundBotEvent(claim") < route.indexOf("handleStaffWhatsApp(from"));
  // A photo, file or video from staff is asked about too — BEFORE screening, the download and the
  // customer inbox. Left to carry on, it was recorded as a customer message, which created a contact
  // on the staff member's own number; a number on a customer record is then unlinked from the assistant.
  const media = branch('} else if (message.type === "image"', '} else if (message.type === "audio"');
  const asked = media.indexOf("if (await handleStaffWhatsApp(from, { mediaId: String(media?.id ?? \"\"), mediaKind: message.type, caption }, message.id)) return;");
  assert.ok(asked > -1);
  for (const later of ['held("media"', "fetchWhatsAppMedia(", "saveFile(", "recordInboundWhatsApp(", "runWhatsAppBot("]) assert.ok(asked < media.indexOf(later), later);
});

// The smallest complete JPEG cleanJpeg accepts, with a metadata segment that must not survive.
const seg = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
const EXIF = seg(0xe1, [..."Exif\0\0GPS -33.9249,18.4241"].map((c) => c.charCodeAt(0)));
const PHOTO = Buffer.from([
  0xff, 0xd8, ...EXIF, ...seg(0xdb, [0x00, ...Array(64).fill(1)]), ...seg(0xc4, [0x00, 1, ...Array(15).fill(0), 0x00]),
  ...seg(0xc0, [8, 0, 16, 0, 16, 1, 1, 0x11, 0]), ...seg(0xda, [1, 1, 0x00, 0, 63, 0]), 0x12, 0x34, 0xff, 0xd9,
]);

test("a photo from staff is read by the assistant; a file or video is answered, and none becomes a customer message", async () => {
  verified("u1", STAFF);
  state.media = { buffer: PHOTO, contentType: "image/jpeg" };
  // With a caption: the caption is the question.
  assert.equal(await handleStaffWhatsApp(STAFF, { mediaId: "m1", mediaKind: "image", caption: "  whose quote is this?  " }, "wamid.IMG"), true);
  assert.equal(state.asked[0].question, "whose quote is this?");
  assert.equal(state.asked[0].source, "whatsapp");
  assert.equal(state.askedImages[0].length, 1);
  assert.match(state.askedImages[0][0], /^data:image\/jpeg;base64,/);
  const sent = Buffer.from(state.askedImages[0][0].split(",")[1], "base64").toString("latin1");
  assert.ok(!sent.includes("GPS") && !sent.includes("Exif"), "rebuilt: no metadata reaches the model");
  assert.equal(state.typing[0]?.id, "wamid.IMG");
  // Without one: a default question.
  await handleStaffWhatsApp(STAFF, { mediaId: "m1", mediaKind: "image", caption: "" });
  assert.equal(state.asked[1].question, "What's in this image, and what should I do with it?");

  // Not read, but ANSWERED — each returns true, so the route never files it as a customer's.
  const refusals: [string, () => void, Parameters<typeof handleStaffWhatsApp>[1], RegExp][] = [
    ["a file", () => {}, { mediaId: "m2", mediaKind: "document", caption: "" }, /not files or videos yet/],
    ["a video", () => {}, { mediaId: "m2", mediaKind: "video", caption: "" }, /not files or videos yet/],
    ["not a JPEG", () => { state.media = { buffer: PHOTO, contentType: "image/png" }; }, { mediaId: "m3", mediaKind: "image", caption: "" }, /couldn't read that image/],
    ["broken bytes", () => { state.media = { buffer: Buffer.from("not a picture"), contentType: "image/jpeg" }; }, { mediaId: "m3", mediaKind: "image", caption: "" }, /couldn't read that image/],
    ["no media id", () => {}, { mediaId: "", mediaKind: "image", caption: "" }, /couldn't read that image/],
    ["over the hourly image allowance", () => { state.imageAllowed = false; }, { mediaId: "m3", mediaKind: "image", caption: "" }, /a lot of images this hour/],
  ];
  for (const [name, arrange, input, reply] of refusals) {
    state.media = { buffer: PHOTO, contentType: "image/jpeg" };
    state.imageAllowed = true;
    state.sent = [];
    const before = state.asked.length;
    arrange();
    assert.equal(await handleStaffWhatsApp(STAFF, input), true, `${name}: dealt with here`);
    assert.equal(state.asked.length, before, `${name}: nothing is asked`);
    assert.match(state.sent[0]?.text ?? "", reply, name);
  }

  // A CUSTOMER's photo is none of this: not staff → false, and it is never downloaded here.
  state.media = { buffer: PHOTO, contentType: "image/jpeg" };
  const fetched = state.mediaFetched;
  assert.equal(await handleStaffWhatsApp(CUSTOMER, { mediaId: "m9", mediaKind: "image", caption: "is this in stock?" }), false);
  assert.equal(state.mediaFetched, fetched, "a customer's photo is not fetched by the assistant");
});

test("the staff path never writes a customer record or runs the bot", () => {
  const lib = code("src/lib/assistantWhatsApp.ts");
  assert.doesNotMatch(lib, /recordInboundWhatsApp|runWhatsAppBot|communication\.|contact\.|lead\.(create|upsert)|createIntakeLead/);
  // Replies go out without a customer `record`, so nothing lands on a timeline.
  for (const call of lib.match(/sendWhatsApp(Text|Buttons)\([^)]*\)/g) ?? []) {
    assert.doesNotMatch(call, /record/, call);
  }
  assert.match(lib, /askCrm\(user, q, null, \{ source: "whatsapp", images, proposeTasks: \(await confirmingOnWhatsAppOn\(\)\) \? true : "saved" \}\)/);
  // Every lookup names the workspace the route entered for the business number.
  assert.match(lib, /const scope = currentTenantScope\(\);\s*if \(!scope \|\| scope\.system \|\| !scope\.tenantId\) return false;\s*const tenantId = scope\.tenantId;/);
  // …and it is the first thing the handler does: nothing runs before it.
  const handler = lib.slice(lib.indexOf("export async function handleStaffWhatsApp"));
  assert.ok(handler.indexOf("currentTenantScope()") < handler.indexOf("await "), "the scope check comes before any await");
  for (const q of lib.match(/assistantPhoneLink\.(findFirst|findMany|updateMany)\(\{\s*where: \{[^}]*\}/g) ?? []) {
    assert.match(q, /tenantId/, q);
  }
});

test("link and unlink touch only the caller's own row, behind the gate and the switch", () => {
  const actions = code("src/app/actions/assistantWhatsApp.ts");
  const start = actions.slice(actions.indexOf("export async function startWhatsAppLink"), actions.indexOf("export async function unlinkMyWhatsApp"));
  assert.match(
    start,
    /requireAnyPermission\(\.\.\.ASSISTANT_PERMISSIONS\);\s*if \(!\(await isModuleEnabled\("automation"\)\)\)[\s\S]*if \(!\(await assistantWhatsAppOn\(\)\)\)[\s\S]*if \(!\(await isWhatsAppConfigured\(\)\)\)/,
  );
  assert.match(start, /registerRateLimitAttempt\(rateLimitKey\("assistant-wa-code", `\$\{tenantId\}:\$\{user\.id\}`\), LINK_CODE_POLICY\)/);
  assert.match(start, /crypto\.randomInt\(0, 1_000_000\)/);
  assert.match(start, /where: \{ tenantId_userId: \{ tenantId, userId: user\.id \} \}/);
  // Only the hash is stored; re-linking clears the old number.
  assert.match(start, /create: \{ tenantId, userId: user\.id, codeHash, codeExpiresAt, sessionVersion \}/);
  assert.match(start, /update: \{ codeHash, codeExpiresAt, waId: null, verifiedAt: null, refusedReason: null, sessionVersion \}/);
  assert.match(start, /const sessionVersion = await callerSessionVersion\(\);/, "the code belongs to the sign-in that asked for it");
  assert.doesNotMatch(start, /code: code|codeHash: code\b/);
  assert.match(start, /logAudit\(/);
  // The caller never names a number or a row.
  assert.match(actions, /export async function startWhatsAppLink\(\)/);
  assert.match(actions, /export async function unlinkMyWhatsApp\(\)/);
  const unlink = actions.slice(actions.indexOf("export async function unlinkMyWhatsApp"));
  assert.match(unlink, /deleteMany\(\{ where: \{ tenantId, userId: user\.id \} \}\)/);
  assert.match(unlink, /logAudit\(/);
  // The switch is the owner's.
  const save = actions.slice(actions.indexOf("export async function saveAssistantWhatsApp"), actions.indexOf("export async function startWhatsAppLink"));
  assert.match(save, /requireTenantOwner\(\)/);
  assert.match(save, /logAudit\(/);
  // The card shows only when the switch is on and WhatsApp is connected.
  const page = code("src/app/(app)/assistant/page.tsx");
  assert.match(page, /if \(!\(await assistantWhatsAppOn\(\)\) \|\| !\(await isWhatsAppConfigured\(\)\)\) return null;/);
});

/* ── what the assistant sends on its own: scheduled briefings and watch alerts ── */

test("a scheduled briefing goes to the linked phone when they wrote in the last 24 hours — once", async () => {
  verified("u1", STAFF).lastInboundAt = new Date(Date.now() - 3 * HOUR);
  const brief = waitingTurn("brief");
  const alert = waitingTurn("alert", 0, "watch");
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "sent");
  assert.deepEqual(state.sent.map((s) => s.to), [STAFF, STAFF]);
  assert.ok(state.sent.some((s) => s.text === "⏰ Scheduled: Question brief\n\nAnswer brief"), "all of it, under what it is");
  assert.ok(state.sent.some((s) => s.text.startsWith("👀 You asked me to watch: Question alert")));
  assert.ok(brief.whatsappSentAt && alert.whatsappSentAt);
  assert.equal(state.templatesSent.length, 0, "no template when a message will do");
  // The next run has nothing left to send.
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "nothing");
  assert.equal(state.sent.length, 2);
});

test("only schedule and watch answers, only this person's, only from the last day", async () => {
  verified("u1", STAFF).lastInboundAt = new Date();
  waitingTurn("typed", 0, "chat");
  waitingTurn("asked-on-phone", 0, "whatsapp");
  waitingTurn("someone-elses", 0, "schedule", "u2");
  waitingTurn("stale", 25);
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "nothing");
  assert.equal(state.sent.length, 0);
});

test("outside the 24 hours NOTHING of the CRM is sent: the template goes instead, once, and it all waits", async () => {
  state.template = "assistant_update_ready|en";
  const link = verified("u1", STAFF);
  link.lastInboundAt = new Date(Date.now() - 30 * HOUR);
  const brief = waitingTurn("brief");
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "nudged");
  assert.deepEqual(state.templatesSent, [{ to: STAFF, name: "assistant_update_ready", language: "en" }]);
  assert.equal(state.sent.length, 0, "Meta would accept the text and fail it later — so it is never tried");
  assert.equal(brief.whatsappSentAt, null, "still waiting");
  assert.ok(link.nudgedAt);
  // The next tick, and the next briefing, do not send the template again.
  waitingTurn("second");
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "waiting");
  assert.equal(state.templatesSent.length, 1);
});

test("a link that has never written in is outside the 24 hours; with no template set it simply waits", async () => {
  verified("u1", STAFF);
  const brief = waitingTurn("brief");
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "waiting");
  assert.equal(state.sent.length + state.templatesSent.length, 0);
  assert.equal(brief.whatsappSentAt, null);
  // A name that is not a template name is no template.
  state.template = "Not A Template!";
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "waiting");
  assert.equal(state.templatesSent.length, 0);
});

test("the tap on the template's button delivers everything that was waiting — and asks nothing", async () => {
  state.template = "assistant_update_ready";
  const link = verified("u1", STAFF);
  link.lastInboundAt = new Date(Date.now() - 30 * HOUR);
  const brief = waitingTurn("brief", 2);
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "nudged");
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "Show me", templateReply: true }, "wamid.tap"), true);
  assert.deepEqual(state.sent.map((s) => s.text), ["⏰ Scheduled: Question brief\n\nAnswer brief"]);
  assert.ok(brief.whatsappSentAt);
  assert.equal(state.asked.length, 0, "the button is not a question");
  assert.equal(link.nudgedAt, null, "after their next silence the template may go again");
  assert.ok(link.lastInboundAt && Date.now() - link.lastInboundAt.getTime() < 5_000, "their message opened the 24 hours");
  // A tap with nothing waiting says so, and still asks nothing.
  state.sent = [];
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "Show me", templateReply: true }, "wamid.tap2"), true);
  assert.match(state.sent[0].text, /Nothing new is waiting/);
  assert.equal(state.asked.length, 0);
  // Something IS waiting but cannot be sent: it never says "nothing is waiting".
  waitingTurn("stuck");
  state.metaRefuses = true;
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "Show me", templateReply: true }, "wamid.tap2b"), true);
  assert.equal(state.turns.find((t) => t.id === "stuck")?.whatsappSentAt, null);
  assert.equal(state.asked.length, 0);
  state.metaRefuses = false;
  // From a phone that is not linked staff it is nobody's.
  assert.equal(await handleStaffWhatsApp(CUSTOMER, { text: "Show me", templateReply: true }, "wamid.tap3"), false);
});

test("any message from the person delivers what was waiting first, then answers them", async () => {
  verified("u1", STAFF);
  waitingTurn("brief", 5);
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "what is overdue today" }, "wamid.q"), true);
  assert.equal(state.sent[0].text, "⏰ Scheduled: Question brief\n\nAnswer brief");
  assert.equal(state.asked.length, 1);
  assert.ok(state.sent.length >= 2, "and their own question is answered after it");
});

test("their own switch, the workspace switch, a reset sign-in and a customer's number each stop it — and nothing is marked sent", async () => {
  const fresh = () => {
    state.links = [];
    state.turns = [];
    state.sent = [];
    const link = verified("u1", STAFF);
    link.lastInboundAt = new Date();
    return { link, brief: waitingTurn("brief") };
  };
  let { link, brief } = fresh();
  link.updatesOnWhatsApp = false;
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "not_wanted");

  ({ link, brief } = fresh());
  state.switch = "off";
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "not_wanted");
  state.switch = "on";

  ({ link, brief } = fresh());
  state.sessionVersions.set("u1", 2);
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "not_safe");
  state.sessionVersions = new Map();

  ({ link, brief } = fresh());
  state.customers.add(STAFF);
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "not_safe");
  state.customers = new Set();

  // A link in another workspace is not this one's.
  ({ link, brief } = fresh());
  link.tenantId = "t2";
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "not_wanted");

  assert.equal(state.sent.length + state.templatesSent.length, 0);
  assert.equal(brief.whatsappSentAt, null);
});

test("Meta refusing although our clock said open: it is not marked sent, and the template is the way through", async () => {
  state.template = "assistant_update_ready|en_US";
  verified("u1", STAFF).lastInboundAt = new Date();
  const brief = waitingTurn("brief");
  state.metaRefuses = true;
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "nudged");
  assert.equal(brief.whatsappSentAt, null, "released: it waits for the tap");
  assert.deepEqual(state.templatesSent, [{ to: STAFF, name: "assistant_update_ready", language: "en_US" }]);
  // Refused straight after they wrote is not the 24-hour rule: no template, a failure.
  state.templatesSent = [];
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1", { windowOpen: true }), "failed");
  assert.equal(state.templatesSent.length, 0);
  assert.equal(brief.whatsappSentAt, null);
});

/* ── delivery that can be relied on (review of #860) ───────────────────── */

/** A briefing too long for one WhatsApp message: its parts, as they will be sent. */
function longTurn(id: string): { turn: Turn; parts: string[] } {
  const turn = waitingTurn(id);
  turn.answer = Array.from({ length: 140 }, (_, i) => `Paragraph ${i + 1} of ${id}: the customer wants delivery before month end and has asked for a call.`).join("\n\n");
  const parts = splitForWhatsApp(updateText(turn));
  assert.ok(parts.length >= 3, `needs several messages, got ${parts.length}`);
  return { turn, parts };
}

test("a long briefing whose second message fails is NOT recorded as sent — and resumes at the second message", async () => {
  verified("u1", STAFF).lastInboundAt = new Date();
  const { turn, parts } = longTurn("long");
  state.textFailsFrom = 1;
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "failed");
  assert.deepEqual(state.sent.map((s) => s.text), [parts[0]], "only the first message went");
  assert.equal(turn.whatsappSentAt, null, "a partial send is not a complete one");
  assert.equal(turn.whatsappPartsSent, 1, "what has gone is remembered");
  assert.equal(turn.whatsappClaimedAt, null, "and it is given back at once, to be tried again");
  // WhatsApp is back: the rest goes — not the first message a second time.
  state.textFailsFrom = null;
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "sent");
  assert.deepEqual(state.sent.map((s) => s.text), parts, "every message exactly once, in order");
  assert.ok(turn.whatsappSentAt, "sent only now that all of it has gone");
  assert.equal(turn.whatsappPartsSent, parts.length);
});

test("a sender that stopped mid-way does not hold a briefing for ever: its claim expires and the next one resumes", async () => {
  verified("u1", STAFF).lastInboundAt = new Date();
  const { turn, parts } = longTurn("crashed");
  // Somebody claimed it a moment ago, sent one message, and is (as far as anyone knows) still at it.
  turn.whatsappClaimedAt = new Date(Date.now() - 60_000);
  turn.whatsappPartsSent = 1;
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "nothing", "a live claim is left alone — never two senders on one briefing");
  assert.equal(state.sent.length, 0);
  // That sender never came back.
  turn.whatsappClaimedAt = new Date(Date.now() - UPDATE_CLAIM_MS - 1_000);
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "sent");
  assert.deepEqual(state.sent.map((s) => s.text), parts.slice(1), "taken over from where it had got to");
  assert.ok(turn.whatsappSentAt);
  assert.equal(turn.whatsappClaimedAt, null);
});

test("seven waiting updates all arrive on one tap — the queue is drained, not sampled", async () => {
  state.template = "assistant_update_ready";
  const link = verified("u1", STAFF);
  link.lastInboundAt = new Date(Date.now() - 30 * HOUR);
  const turns = Array.from({ length: 7 }, (_, i) => waitingTurn(`u${i + 1}`, 7 - i));
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "nudged");
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "Show me", templateReply: true }, "wamid.seven"), true);
  assert.deepEqual(state.sent.map((s) => s.text), turns.map((t) => `⏰ Scheduled: ${t.question}\n\n${t.answer}`), "all seven, oldest first, and nothing else");
  assert.ok(turns.every((t) => t.whatsappSentAt));
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "nothing");
});

test("a backlog past one call's limit is SAID, and the next message carries on to the end", async () => {
  verified("u1", STAFF);
  const turns = Array.from({ length: UPDATE_MAX + 3 }, (_, i) => waitingTurn(`b${i}`, 20 - i * 0.1));
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "Show me", templateReply: true }, "wamid.backlog"), true);
  assert.equal(turns.filter((t) => t.whatsappSentAt).length, UPDATE_MAX);
  assert.match(state.sent.at(-1)!.text, /more updates waiting/);
  assert.equal(state.sent.length, UPDATE_MAX + 1, "the updates, then the one line saying there is more");
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "Show me", templateReply: true }, "wamid.backlog2"), true);
  assert.ok(turns.every((t) => t.whatsappSentAt), "the rest arrived");
});

test("a template that could not be SENT is tried again after a pause — a briefing is not lost to one bad minute", async () => {
  state.template = "assistant_update_ready";
  const link = verified("u1", STAFF);
  link.lastInboundAt = new Date(Date.now() - 30 * HOUR);
  const brief = waitingTurn("brief");
  for (const failure of ["Could not reach WhatsApp (timed out)", "WhatsApp API error 503", "throws"]) {
    link.nudgedAt = null;
    link.nudgeFailedAt = null;
    state.templateFails = failure;
    assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "failed", failure);
    assert.equal(link.nudgedAt, null, `${failure}: the nudge is given back, not counted as made`);
    assert.ok(link.nudgeFailedAt, failure);
  }
  // Not hammered: the next caller, a moment later, does not try again.
  const tries = state.templateTries;
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "waiting");
  assert.equal(state.templateTries, tries);
  // After the pause, with WhatsApp back, it goes.
  link.nudgeFailedAt = new Date(Date.now() - NUDGE_RETRY_MS - 1_000);
  state.templateFails = null;
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "nudged");
  assert.equal(state.templatesSent.length, 1);
  assert.ok(link.nudgedAt);
  assert.equal(link.nudgeFailedAt, null);
  assert.equal(brief.whatsappSentAt, null, "still waiting for the tap");
});

test("a template Meta REFUSES is not sent again and again", async () => {
  state.template = "assistant_update_ready";
  const link = verified("u1", STAFF);
  link.lastInboundAt = new Date(Date.now() - 30 * HOUR);
  waitingTurn("brief");
  state.templateFails = "(#132001) Template name does not exist in the translation";
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "failed");
  assert.ok(link.nudgedAt, "counted, so it is not repeated");
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "waiting");
  assert.equal(state.templateTries, 1);
  assert.ok(state.errors.some((e) => /refused by WhatsApp, not retried today/.test(e)), "and the log says which kind of failure it was");
  // Their next message clears it all: a corrected template can go after the next silence.
  await handleStaffWhatsApp(STAFF, { text: "hello" }, "wamid.clear");
  assert.equal(link.nudgedAt, null);
  assert.equal(link.nudgeFailedAt, null);
});

test("the half-hourly sweep retries what is still waiting — for people who may still use the assistant", async () => {
  verified("u1", STAFF).lastInboundAt = new Date();
  verified("u2", "27825550002").lastInboundAt = new Date();
  verified("gone", "27825550003").lastInboundAt = new Date();
  const mine = waitingTurn("mine");
  const theirs = waitingTurn("theirs", 0, "watch", "u2");
  const leavers = waitingTurn("leavers", 0, "schedule", "gone");
  waitingTurn("done").whatsappSentAt = new Date();
  assert.deepEqual(await sweepWaitingUpdates("t1", PLENTY), { people: 2 });
  assert.ok(mine.whatsappSentAt && theirs.whatsappSentAt);
  assert.equal(leavers.whatsappSentAt, null, "someone who lost access is sent nothing");
  assert.equal(state.sent.length, 2);
  state.switch = "off";
  waitingTurn("later");
  assert.deepEqual(await sweepWaitingUpdates("t1", PLENTY), { people: 0 });
  // The cron calls it for every workspace WITH ITS BUDGET, and its failure cannot stop the watches or the schedules.
  const cron = code("src/app/api/cron/assistant/route.ts");
  assert.match(cron, /await sweepWaitingUpdates\(tenantId, budget\)\.catch\(\(error: unknown\) =>\s*logError\("assistant-schedule", "waiting updates sweep failed"/);
});

/* ── a cron's time is shared (second review of #860) ───────────────────── */

/** A cron budget with all the time in the world. */
const PLENTY = { shouldStop: () => false };
/** A budget on a clock the test moves: `left` ms remain, and each WhatsApp send costs `perSend` of them. */
function budgetOf(left: number, perSend: number) {
  const clock = { left, asked: [] as (number | undefined)[] };
  state.onSend = () => { clock.left -= perSend; };
  return { clock, shouldStop: (reserveMs = 0) => (clock.asked.push(reserveMs), clock.left < reserveMs) };
}

test("the sweep stops when the cron's time is short — a slow WhatsApp cannot eat the scheduled questions' time", async () => {
  // Three people, three briefings each; every send takes 15 seconds; the tick has 60 seconds for this.
  const people = ["u1", "u2", "u3"];
  state.members = new Set(people);
  people.forEach((u, i) => { verified(u, `2782555010${i}`).lastInboundAt = new Date(); });
  const turns = people.flatMap((u) => [1, 2, 3].map((n) => waitingTurn(`${u}-${n}`, 5 - n, "schedule", u)));
  const { clock, shouldStop } = budgetOf(60_000, 15_000);
  const swept = await sweepWaitingUpdates("t1", { shouldStop });
  // 60s → send (45s left) → send (30s) → send (15s, under the 20s a message needs) → stop.
  assert.equal(state.sent.length, 3, "it sent what there was time for, and no more");
  assert.equal(swept.people, 1, "and did not start on the next person");
  assert.ok(clock.left >= 0, `never past the budget (${clock.left} ms left)`);
  assert.ok(clock.asked.every((reserve) => reserve === UPDATE_SEND_RESERVE_MS), "every check keeps room for a whole message");
  assert.equal(turns.filter((t) => t.whatsappSentAt).length, 3);
  assert.ok(turns.filter((t) => !t.whatsappSentAt).every((t) => t.whatsappClaimedAt === null), "nothing unfinished is left claimed");
  // The next tick, with time, finishes the job: nothing was lost and nothing is sent twice.
  state.onSend = null;
  await sweepWaitingUpdates("t1", PLENTY);
  assert.ok(turns.every((t) => t.whatsappSentAt));
  assert.equal(state.sent.length, 9);
  assert.equal(new Set(state.sent.map((s) => s.text)).size, 9);
});

test("a budget already spent sends nothing at all, and one that runs out mid-briefing leaves it resumable", async () => {
  verified("u1", STAFF).lastInboundAt = new Date();
  const { turn, parts } = longTurn("slow");
  assert.deepEqual(await sweepWaitingUpdates("t1", budgetOf(5_000, 15_000)), { people: 0 });
  assert.equal(state.sent.length, 0);
  assert.equal(turn.whatsappClaimedAt, null);
  // Time for exactly one message of a several-message briefing.
  const { shouldStop } = budgetOf(30_000, 15_000);
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1", { shouldStop }), "more");
  assert.deepEqual(state.sent.map((s) => s.text), [parts[0]]);
  assert.equal(turn.whatsappPartsSent, 1);
  assert.equal(turn.whatsappSentAt, null);
  assert.equal(turn.whatsappClaimedAt, null, "given back at once, not left to expire");
  state.onSend = null;
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "sent");
  assert.deepEqual(state.sent.map((s) => s.text), parts);
});

test("the template waits on WhatsApp too: with no time left it is not started, and not counted as made", async () => {
  state.template = "assistant_update_ready";
  const link = verified("u1", STAFF);
  link.lastInboundAt = new Date(Date.now() - 30 * HOUR);
  waitingTurn("brief");
  // Under the 20 seconds a send may need.
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1", { shouldStop: (reserveMs = 0) => 10_000 < reserveMs }), "waiting");
  assert.equal(state.templateTries, 0);
  assert.equal(link.nudgedAt, null, "nothing claimed: the next tick is free to send it");
  // The next tick has time.
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1", PLENTY), "nudged");
  assert.equal(state.templatesSent.length, 1);
});

test("a sender that lost its claim cannot write over the one that took it", async () => {
  verified("u1", STAFF).lastInboundAt = new Date();
  const { turn, parts } = longTurn("overtaken");
  // While this sender's first message is in flight, its claim expires and another sender takes the briefing and finishes it.
  const takenAt = new Date();
  state.onSend = () => {
    state.onSend = null;
    Object.assign(turn, { whatsappClaimedAt: takenAt, whatsappPartsSent: parts.length });
  };
  // Not a failure: the briefing is the other sender's now, and nothing is left for this one to do.
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "sent");
  assert.equal(state.sent.length, 1, "it sends no further messages of it");
  assert.equal(turn.whatsappPartsSent, parts.length, "the other sender's progress is not put back to 1");
  assert.equal(turn.whatsappClaimedAt, takenAt, "nor its claim cleared");
  assert.equal(turn.whatsappSentAt, null, "and it is not marked sent on that sender's behalf");
  const lib = code("src/lib/assistantWhatsApp.ts");
  const one = lib.slice(lib.indexOf("async function sendOneUpdate"), lib.indexOf("const OUT_OF_TIME"));
  // (Two of the six give an update back when its PDF cannot go yet — out of time, or WhatsApp refused the document.)
  assert.equal(one.match(/whatsappClaimedAt: mine \}, data:/g)?.length, 6, "every write after the claim names the claim");
  assert.equal(one.match(/assistantTurn\.updateMany\(/g)?.length, 7, "the claim itself, and six writes that name it");
});

test("which template failures may pass, and which are refusals", () => {
  for (const passing of ["Could not reach WhatsApp (timed out)", "Could not reach WhatsApp (TypeError)", "WhatsApp API error 500", "WhatsApp API error 429", "(#130429) Rate limit hit", "Service temporarily unavailable"]) {
    assert.equal(nudgeFailureMayPass(passing), true, passing);
  }
  for (const refusal of ["(#132001) Template name does not exist in the translation", "(#132015) Template is paused", "WhatsApp API error 400", "WhatsApp is not configured (Settings → Integrations).", "", null]) {
    assert.equal(nudgeFailureMayPass(refusal), false, String(refusal));
  }
});

test("the rules: the window, the template name, and what is sent", () => {
  const now = Date.now();
  assert.equal(replyWindowOpen(null), false);
  assert.equal(replyWindowOpen(new Date(now - 23 * HOUR), now), true);
  assert.equal(replyWindowOpen(new Date(now - 24 * HOUR + 60_000), now), false, "a margin: not sent at 23:59 to fail at 24:01");
  assert.deepEqual(parseUpdateTemplate("assistant_update_ready"), { name: "assistant_update_ready", language: "en" });
  assert.deepEqual(parseUpdateTemplate("dax_update|af"), { name: "dax_update", language: "af" });
  assert.equal(parseUpdateTemplate(""), null);
  assert.equal(parseUpdateTemplate("Has Spaces"), null);
  assert.equal(parseUpdateTemplate(formatUpdateTemplate(" dax_update ", ""))?.language, "en");
  assert.equal(outsideReplyWindow("Outside the 24-hour reply window — the customer must message you first"), true);
  assert.equal(outsideReplyWindow("(#131047) Re-engagement message"), true);
  assert.equal(outsideReplyWindow("WhatsApp send failed"), false);
  assert.deepEqual([...PROACTIVE_SOURCES], ["schedule", "watch", "handoff", "quote_pdf"]);
});

test("wired where it must be: after a saved briefing, after a saved alert, on the template's button — and each switch is the right person's", () => {
  const run = code("src/lib/assistantScheduleRun.ts");
  // Both run inside a cron: each hands over that cron's budget.
  assert.match(run, /if \(delivered\) \{\s*const outcome = await sendUpdatesToLinkedPhone\(tenantId, user\.id, \{ shouldStop: budget\.shouldStop \}\);/);
  const watch = code("src/lib/assistantWatch.ts");
  assert.match(watch, /if \(!delivered\) continue;[\s\S]*const outcome = await sendUpdatesToLinkedPhone\(tenantId, user\.id, \{ shouldStop: budget\.shouldStop \}\);/);
  // A failure is logged as a fixed line (assistantSchedules/assistantWatch tests forbid anything else in it).
  for (const src of [run, watch]) assert.match(src, /if \(outcome === "failed"\) await logError\("assistant-(schedule|watch)", "(briefing|alert) not sent to WhatsApp"\)/);
  const route = code("src/app/api/webhooks/whatsapp/route.ts");
  assert.match(route, /\} else if \(message\.type === "button"\) \{[\s\S]*?await handleStaffWhatsApp\(from, \{ text: String\(message\.button\?\.text \?\? ""\), templateReply: true \}, message\.id\);\s*\} else if/);
  // The window opens only after every check on the incoming message has passed.
  const lib = code("src/lib/assistantWhatsApp.ts");
  const handler = lib.slice(lib.indexOf("export async function handleStaffWhatsApp"), lib.indexOf("// A tapped Confirm button"));
  assert.ok(handler.indexOf("const user = await assistantUserFor(link.userId);") < handler.indexOf("lastInboundAt: new Date()"));
  assert.match(handler, /where: \{ id: link\.id, tenantId, waId \}, data: \{ lastInboundAt: new Date\(\), nudgedAt: null, nudgeFailedAt: null \}/);
  assert.match(lib, /if \(caughtUp === "failed" \|\| caughtUp === "not_safe"\) await sendPlan\(waId, \{ texts: \["I couldn't send your update here just now\./, "a failed delivery is not reported as 'nothing waiting'");
  // The template carries no variables: nothing of the CRM's is in it.
  const wa = code("src/lib/whatsapp.ts");
  assert.match(wa, /type: "template", template: \{ name, language: \{ code: languageCode \} \} \}\)/);
  // Each person's own switch names only their own row; the template is the owner's, and audited.
  const actions = code("src/app/actions/assistantWhatsApp.ts");
  const mine = actions.slice(actions.indexOf("export async function setMyWhatsAppUpdates"), actions.indexOf("export async function unlinkMyWhatsApp"));
  assert.match(mine, /const user = await requireUser\(\);/);
  assert.match(mine, /where: \{ tenantId, userId: user\.id, updatesOnWhatsApp: on !== true \}/);
  assert.match(mine, /logAudit\(/);
  const settings = code("src/app/actions/assistantSettings.ts");
  const card = settings.slice(settings.indexOf("export async function saveAssistantWhatsAppCard"));
  assert.match(card, /const user = await requireTenantOwner\(\);[\s\S]*putSetting\(ASSISTANT_WHATSAPP_TEMPLATE_KEY, stored\);\s*await logAudit\(/);
});

/* ── a quote the assistant built: its PDF, to the person who asked ─────── */

const QUOTE_ID = "cmquoteabcdefghijklmnopq";
/** A draft quote u1 had the assistant build, and the update that carries its PDF. */
function builtQuote(over: Partial<Turn> = {}) {
  state.quotes.push({ id: QUOTE_ID, tenantId: "t1", createdById: "u1", deletedAt: null, number: 1030 });
  const turn = waitingTurn("quote", 0, "quote_pdf");
  Object.assign(turn, { question: "Draft quote Q-1030", answer: "I've created draft quote Q-1030. It has NOT been sent to the customer.", quoteId: QUOTE_ID, ...over });
  return turn;
}

test("A BUILT QUOTE'S PDF goes to the linked phone of the person who asked: the words, then the document — and nothing to a customer", async () => {
  const link = verified("u1", STAFF);
  link.lastInboundAt = new Date();
  const turn = builtQuote();
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "sent");
  assert.match(state.sent[0].text, /^🧾 Draft quote Q-1030\n\nI've created draft quote Q-1030\. It has NOT been sent to the customer\./);
  assert.deepEqual(state.rendered, [QUOTE_ID]);
  // ONE document, to the linked staff phone, with no fourth argument: no customer timeline entry.
  assert.equal(state.documents.length, 1);
  const [to, file, caption, ...rest] = state.documents[0] as [string, { filename: string; contentType: string }, string, ...unknown[]];
  assert.equal(to, STAFF);
  assert.equal(file.filename, "Quote-Q-1030.pdf");
  assert.equal(file.contentType, "application/pdf");
  assert.equal(caption, "Draft quote Q-1030 — for you. Not sent to the customer.");
  assert.deepEqual(rest, []);
  assert.ok(turn.whatsappSentAt instanceof Date, "finished only once the document has gone");
  assert.ok(state.audits.some((summary) => /Q-1030/.test(summary) && /not to the customer/.test(summary)));
  // Run again: nothing is waiting, nothing is re-sent.
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "nothing");
  assert.equal(state.documents.length, 1);
});

test("THE PDF IS NOT LOST when its send fails: the update stays waiting, and the retry sends ONLY the document", async () => {
  // Review of #872: the task was marked done before the PDF was rendered and sent, so a
  // crash or timeout there lost the PDF for good and a second tap could not bring it back.
  const link = verified("u1", STAFF);
  link.lastInboundAt = new Date();
  const turn = builtQuote();
  state.documentFails = true;
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "failed");
  assert.equal(state.sent.length, 1, "the words went");
  assert.equal(turn.whatsappSentAt, null, "…but it is NOT finished");
  assert.equal(turn.whatsappClaimedAt, null, "given back at once for the next sender");
  assert.equal(turn.whatsappPartsSent, 1, "with the words counted as gone");
  // The half-hourly sweep (or their next message) tries again.
  state.documentFails = false;
  await sweepWaitingUpdates("t1", { shouldStop: () => false });
  assert.equal(state.sent.length, 1, "the words are not repeated");
  assert.equal(state.documents.length, 1, "the document arrives");
  assert.notEqual(state.turns.find((t) => t.id === "quote")?.whatsappSentAt ?? null, null, "and only now is it finished");
  // Never a second quote: this path only ever reads the quote.
  const lib = code("src/lib/assistantWhatsApp.ts");
  const sender = lib.slice(lib.indexOf("async function sendQuotePdfToStaff("), lib.indexOf("const OUT_OF_TIME"));
  assert.doesNotMatch(sender, /quote\.(create|update|updateMany|delete)|saveQuoteDraft|runAssistantAction|status:/);
});

test("it is re-checked at the moment of sending: a phone no longer safely theirs, or a quote not theirs, gets no document", async () => {
  // The number has landed on a customer record since: nothing of it goes anywhere.
  let link = verified("u1", STAFF);
  link.lastInboundAt = new Date();
  builtQuote();
  state.customers.add(STAFF);
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "not_safe");
  assert.deepEqual([state.sent.length, state.documents.length], [0, 0]);
  state.customers = new Set();
  // Sign-ins reset since the phone was linked.
  state.sessionVersions.set("u1", 2);
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "not_safe");
  assert.equal(state.documents.length, 0);
  state.sessionVersions = new Map();

  // A quote somebody else created, another workspace's, or one deleted since: the words go, no document does.
  for (const change of [{ createdById: "u2" }, { tenantId: "t2" }, { deletedAt: new Date() }]) {
    state.links = []; state.turns = []; state.quotes = []; state.sent = []; state.documents = []; state.rendered = [];
    link = verified("u1", STAFF);
    link.lastInboundAt = new Date();
    const turn = builtQuote();
    Object.assign(state.quotes[0], change);
    assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "sent", JSON.stringify(change));
    assert.deepEqual([state.rendered.length, state.documents.length], [0, 0], JSON.stringify(change));
    assert.ok(turn.whatsappSentAt instanceof Date);
  }
  // No longer a member who may use the assistant: no document.
  state.links = []; state.turns = []; state.quotes = []; state.sent = []; state.documents = [];
  link = verified("u1", STAFF);
  link.lastInboundAt = new Date();
  builtQuote();
  state.members = new Set(["u2"]);
  await sendUpdatesToLinkedPhone("t1", "u1");
  assert.equal(state.documents.length, 0);
});

test("a PDF that cannot be made is said once and not retried for ever", async () => {
  const link = verified("u1", STAFF);
  link.lastInboundAt = new Date();
  const turn = builtQuote();
  state.noPdf = true;
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "sent");
  assert.equal(state.documents.length, 0);
  assert.match(state.sent.at(-1)?.text ?? "", /^I couldn't make the PDF for Q-1030\. The draft is in the CRM/);
  assert.ok(turn.whatsappSentAt instanceof Date);
});

test("they ASKED for it: the PDF goes even with 'send my updates to this phone' off — and nothing else does", async () => {
  const link = verified("u1", STAFF);
  link.lastInboundAt = new Date();
  link.updatesOnWhatsApp = false;
  const brief = waitingTurn("brief", 0, "schedule");
  const turn = builtQuote();
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "sent");
  assert.equal(state.documents.length, 1);
  assert.ok(turn.whatsappSentAt instanceof Date);
  assert.equal(brief.whatsappSentAt, null, "the briefing stays in the CRM, as they chose");
  // With no PDF waiting it is what it always was.
  assert.equal(await sendUpdatesToLinkedPhone("t1", "u1"), "not_wanted");
});

test("confirmed on WhatsApp: what the task queued is sent straight after the confirm step's own reply", async () => {
  verified("u1", STAFF);
  state.confirmOn = true;
  state.onConfirm = () => { builtQuote(); };
  assert.equal(await handleStaffWhatsApp(STAFF, { text: "Confirm", choiceId: "daxc:cmpendingpendingpendingpe" }), true);
  assert.equal(state.confirmed.length, 1);
  assert.equal(state.documents.length, 1, "the PDF follows the confirm");
  assert.equal((state.documents[0] as unknown[])[0], STAFF);
  const lib = code("src/lib/assistantWhatsApp.ts");
  assert.match(lib, /await confirmFromWhatsApp\(tenantId, user, waId, pendingId\);[\s\S]{0,700}await sendUpdatesToLinkedPhone\(tenantId, user\.id, \{ windowOpen: true \}\);\s*return true;/);
});

test("it knows about WhatsApp — and the pinned claims stay true", async () => {
  const { selfKnowledge } = await import("../src/lib/assistantSoul");
  const about = selfKnowledge("DAX");
  assert.match(about, /link their own WhatsApp/);
  assert.match(about, /one-time code/);
  assert.match(about, /reaches them with a Confirm button only if the owner has allowed confirming on WhatsApp\./);
  assert.match(about, /is saved as a card on their Ask page in the CRM, kept for a day, where they press Confirm or Send/);
  assert.match(about, /A message to a customer is never sent from WhatsApp/);
  assert.match(about, /you never send anything to a customer/);
});
