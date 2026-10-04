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
  businessNumberFromLabel,
  formatLinkCode,
  linkCodeHashInput,
  linkCodeText,
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
};
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
  errors: [] as string[],
  audits: [] as string[],
  guesses: new Map<string, number>(),
  asks: new Map<string, number>(),
  customers: new Set<string>(),
  ambiguous: new Set<string>(),
  /** Each account's current sessionVersion (bumped by a password reset / sign out everywhere). */
  sessionVersions: new Map<string, number>(),
};
const ASK_LIMIT = 60;

function matches(row: Link, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = (row as Record<string, unknown>)[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
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
const fakeDb = {
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
      case "./settings": return { getSetting: async (key: string) => (key === "ASSISTANT_WHATSAPP" ? state.switch : null) };
      case "./tenantScope": return { currentTenantScope: () => state.scope };
      case "./whatsapp": return {
        waDigits: (p: string) => { const d = p.replace(/\D/g, ""); return d.startsWith("0") ? "27" + d.slice(1) : d; },
        sendWhatsAppText: async (to: string, text: string) => { state.sent.push({ to, text }); return { ok: true }; },
        sendWhatsAppButtons: async (to: string, text: string, buttons: { title: string }[]) => {
          state.sent.push({ to, text, buttons: buttons.map((b) => b.title) }); return { ok: true };
        },
        fetchWhatsAppMedia: async () => { state.mediaFetched++; return { buffer: Buffer.from("x"), contentType: "audio/ogg" }; },
        // A number on a customer record in this workspace (the real one scopes by tenant).
        matchByPhone: async (digits: string) => ({
          contactId: state.customers.has(digits) ? "contact-1" : null,
          leadId: null,
          ambiguous: state.ambiguous.has(digits),
        }),
      };
      case "./transcribe": return { transcribeVoice: async () => "what is overdue today" };
      case "./crmAssistant": return {
        askCrm: async (user: { id: string }, question: string, _page: unknown, opts: { source?: string }) => {
          state.asked.push({ userId: user.id, question, source: opts.source });
          return { ok: true, answer: "Two follow-ups are overdue.", rows: [], tools: [], learned: 0, actions: [], choices: ["Show them"] };
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
      };
      case "./userSecurity": return {
        getUserSecurityStateFresh: async (id: string) => ({ sessionVersion: state.sessionVersions.get(id) ?? 1, disabledAt: null }),
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
const { handleStaffWhatsApp, hashLinkCode } = require_("../src/lib/assistantWhatsApp.ts") as typeof import("../src/lib/assistantWhatsApp");

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
  const row: Link = { id: `linked-${tenantId}-${userId}`, tenantId, userId, waId, codeHash: null, codeExpiresAt: null, verifiedAt: new Date(), sessionVersion: 1 };
  state.links.push(row);
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
  state.errors = [];
  state.audits = [];
  state.guesses = new Map();
  state.asks = new Map();
  state.customers = new Set();
  state.ambiguous = new Set();
  state.sessionVersions = new Map();
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
    assert.match(state.audits.at(-1) ?? "", /Refused to link WhatsApp •••000: that number is on a customer record/);
    // …and it is still not staff afterwards.
    assert.equal(await handleStaffWhatsApp(CUSTOMER, { text: "what's in the pipeline?" }), false);
    assert.equal(state.asked.length, 0);
  }
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
    ["text", text, "handleStaffWhatsApp(from, { text })"],
    ["interactive", interactive, "handleStaffWhatsApp(from, { text: title })"],
    ["audio", audio, "handleStaffWhatsApp(from, { voiceMediaId: mediaId })"],
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
  // Images and files from staff take today's path.
  assert.doesNotMatch(branch('} else if (message.type === "image"', '} else if (message.type === "audio"'), /handleStaffWhatsApp/);
});

test("the staff path never writes a customer record or runs the bot", () => {
  const lib = code("src/lib/assistantWhatsApp.ts");
  assert.doesNotMatch(lib, /recordInboundWhatsApp|runWhatsAppBot|communication\.|contact\.|lead\.(create|upsert)|createIntakeLead/);
  // Replies go out without a customer `record`, so nothing lands on a timeline.
  for (const call of lib.match(/sendWhatsApp(Text|Buttons)\([^)]*\)/g) ?? []) {
    assert.doesNotMatch(call, /record/, call);
  }
  assert.match(lib, /askCrm\(user, q, null, \{ source: "whatsapp" \}\)/);
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
  assert.match(start, /update: \{ codeHash, codeExpiresAt, waId: null, verifiedAt: null, sessionVersion \}/);
  assert.match(start, /const sessionVersion = security\.sessionVersion;/, "the code belongs to the sign-ins it was issued under");
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

test("it knows about WhatsApp — and the pinned claims stay true", async () => {
  const { selfKnowledge } = await import("../src/lib/assistantSoul");
  const about = selfKnowledge("DAX");
  assert.match(about, /link their own WhatsApp/);
  assert.match(about, /one-time code/);
  assert.match(about, /There you only answer — tasks still need a tap on Confirm in the CRM/);
  assert.match(about, /you never send anything to a customer/);
});
