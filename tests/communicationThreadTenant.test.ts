import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Module, { createRequire } from "node:module";

/**
 * A MESSAGE BELONGS TO THE THREAD IT IS ON, NOT TO THE PERSON THE THREAD IS ABOUT.
 *
 * Production, 2026-08-11T14:03Z, `POST /leads/cmsitx03z0005if04pz0b3lmx`:
 *
 *   Invalid `prisma.communication.create()` invocation:
 *   Foreign key constraint violated on the constraint:
 *   `Communication_tenantId_conversationId_fkey`
 *
 * The lead had been claimed by the tenant backfill. Its conversation had not — one
 * of six on production still carrying `tenantId = NULL`. The Communication took its
 * owner from the SUBJECT, so an owned child was offered to an unowned parent and
 * PostgreSQL refused it. Adding a note to any of those six records was impossible.
 *
 * WHAT THIS FILE DOES DIFFERENTLY FROM A MOCK THAT AGREES WITH ME. The fake below
 * enforces the composite foreign keys with real MATCH SIMPLE semantics — a key with
 * any NULL column is not checked, and a key with none must find its parent row — and
 * the first test drives the OLD wiring through it to show the exact production error
 * coming back out. A fixture that could not fail cannot prove a fix; this one fails
 * on demand, and the tests after it show the same fixture accepting the new wiring.
 *
 * The code under test is the real `attachToConversation`, reached through the real
 * `resolveConversationId` and the real `customerRecordTenantId` — the same three
 * functions `prisma.communication.create()` runs through in production. Only the
 * database underneath them is fake.
 */

/* ── the incident's own rows ───────────────────────────────────────── */

const OWNER = "tenant_denago_cpt";
const OTHER = "tenant_stellenbosch_ev";
const LEAD = "cmsitx03z0005if04pz0b3lmx";

/* ── a Postgres that actually refuses things ───────────────────────── */

type Row = Record<string, unknown>;

/**
 * `(tenantId, <column>) → <parent>(tenantId, id)`, as migration 20260727140000
 * declares them and 20260727180000 validated them.
 */
const COMPOSITE_FKS: Record<string, Array<{ column: string; parent: string; constraint: string }>> = {
  communication: [
    { column: "conversationId", parent: "conversation", constraint: "Communication_tenantId_conversationId_fkey" },
    { column: "contactId", parent: "contact", constraint: "Communication_tenantId_contactId_fkey" },
    { column: "leadId", parent: "lead", constraint: "Communication_tenantId_leadId_fkey" },
  ],
  conversation: [
    { column: "contactId", parent: "contact", constraint: "Conversation_tenantId_contactId_fkey" },
    { column: "leadId", parent: "lead", constraint: "Conversation_tenantId_leadId_fkey" },
  ],
};

class ForeignKeyViolation extends Error {
  readonly code = "P2003";
  constructor(readonly constraint: string) {
    super(
      "Invalid `prisma.communication.create()` invocation:\n" +
        `Foreign key constraint violated on the constraint: \`${constraint}\``,
    );
    this.name = "PrismaClientKnownRequestError";
  }
}

const tables: Record<string, Row[]> = {};
let ids = 0;

function reset() {
  for (const key of Object.keys(tables)) delete tables[key];
  ids = 0;
}

/**
 * MATCH SIMPLE, which is the whole reason NULL is a legal answer here: if ANY
 * column of a composite key is NULL the key is not checked at all. So an unowned
 * child satisfies every one of its keys, and an owned child must find an owned
 * parent that matches it exactly.
 */
function enforceForeignKeys(model: string, row: Row) {
  for (const fk of COMPOSITE_FKS[model] ?? []) {
    const parentId = row[fk.column];
    const tenantId = row.tenantId;
    if (parentId == null || tenantId == null) continue;
    const found = (tables[fk.parent] ?? []).some(
      (candidate) => candidate.id === parentId && candidate.tenantId === tenantId,
    );
    if (!found) throw new ForeignKeyViolation(fk.constraint);
  }
}

/** Scalar equality plus the one operator `resolveConversationId` uses. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && "not" in (value as Row)) {
      return row[key] !== (value as Row).not;
    }
    return row[key] === value;
  });
}

/**
 * Projected honestly: a column the caller did not select is NOT returned. Without
 * this, dropping `tenantId` from the resolver's `select` would still pass here and
 * fail in production.
 */
function project(row: Row | undefined, select: Row | undefined): Row | null {
  if (!row) return null;
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((key) => [key, row[key] ?? null]));
}

function table(model: string) {
  const rows = () => (tables[model] ??= []);
  const find = (args: { where?: Row; select?: Row; orderBy?: Row } = {}) => {
    let candidates = rows().filter((row) => matches(row, args.where ?? {}));
    const [orderKey] = Object.keys(args.orderBy ?? {});
    if (orderKey) {
      candidates = [...candidates].sort((a, b) => Number(b[orderKey] ?? 0) - Number(a[orderKey] ?? 0));
    }
    return Promise.resolve(project(candidates[0], args.select));
  };
  return {
    findUnique: find,
    findFirst: find,
    create: (args: { data: Row; select?: Row }) => {
      ids += 1;
      const row = { id: `${model}-${ids}`, ...args.data };
      enforceForeignKeys(model, row);
      rows().push(row);
      return Promise.resolve(project(row, args.select) ?? row);
    },
  };
}

const fakeDb = new Proxy({} as Record<string, unknown>, {
  get(target, prop: string) {
    if (typeof prop !== "string" || prop.startsWith("$") || prop === "then") return undefined;
    if (!target[prop]) target[prop] = table(prop);
    return target[prop];
  },
});

/** The same client, typed, for the calls this file makes directly rather than injects. */
const db = fakeDb as unknown as Record<string, ReturnType<typeof table>>;

/* ── module interception, anchored on the requesting file ──────────── */

type Loader = (
  this: unknown,
  request: string,
  parent: { filename?: string } | undefined,
  isMain: boolean,
) => unknown;

const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
const from = (parent: { filename?: string } | undefined, file: string) =>
  (parent?.filename ?? "").replace(/\\/g, "/").endsWith(file);

loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only" || request === "client-only") return {};
  if (from(parent, "src/lib/tenantWrite.ts") && request === "./db") return { basePrisma: {} };
  if (from(parent, "src/lib/conversations.ts") && request === "./db") {
    return { basePrisma: fakeDb, prisma: fakeDb };
  }
  if (from(parent, "src/lib/customerRecordTenant.ts")) {
    if (request === "./db") return { basePrisma: fakeDb };
    // The acting tenant is only reached when a row points at NOTHING, which no
    // message in this file does. Stubbed so the real one's `./auth` import (and
    // with it most of the app) stays out of a test about foreign keys.
    if (request === "./actingTenant") {
      return { actingTenantId: () => Promise.reject(new Error("no parent to ask — not this test's path")) };
    }
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const require_ = createRequire(import.meta.url);
const conversations = require_("../src/lib/conversations.ts") as typeof import("../src/lib/conversations");
const { customerRecordTenantId } = require_(
  "../src/lib/customerRecordTenant.ts",
) as typeof import("../src/lib/customerRecordTenant");
const { TenantParentConflictError } = require_(
  "../src/lib/compositeTenantRules.ts",
) as typeof import("../src/lib/compositeTenantRules");

/* ── the writer, as `addCommunication` actually writes it ──────────── */

type NotePayload = { leadId?: string; contactId?: string; conversationId?: string };

/**
 * The note payload every caller builds: `tenantId` stamped from the SUBJECT via the
 * shared helper (src/app/actions/communications.ts:94 and eighteen siblings), then
 * handed to `prisma.communication.create()`.
 */
async function typeANote(payload: NotePayload): Promise<Row> {
  return {
    type: "note",
    direction: null,
    body: "Customer called back about the charger.",
    userId: "user-1",
    ...payload,
    tenantId: await customerRecordTenantId({ contactId: payload.contactId, leadId: payload.leadId }),
  };
}

/** `prisma.communication.create()`, as db.ts wires it: attach, then INSERT. */
async function saveNote(data: Row): Promise<Row> {
  await conversations.attachToConversation(data as never);
  return db.communication.create({ data });
}

/** The wiring as it shipped last night: the id from the thread, the tenant from the subject. */
async function saveNoteTheOldWay(data: Row): Promise<Row> {
  const conversation = await conversations.resolveConversationId(data as never);
  if (conversation && !data.conversationId) data.conversationId = conversation.id;
  return db.communication.create({ data });
}

/** The incident's fixture: an owned lead, and a thread the backfill never reached. */
function legacyThread() {
  reset();
  tables.lead = [{ id: LEAD, tenantId: OWNER }];
  tables.conversation = [
    { id: "conversation-legacy", channel: "note", status: "open", leadId: LEAD, tenantId: null, lastMessageAt: 1 },
  ];
}

/* ── 1. the reproduction ───────────────────────────────────────────── */

test("REPRODUCTION: the shipped wiring is refused by the constraint production named", async () => {
  legacyThread();
  const note = await typeANote({ leadId: LEAD });
  assert.equal(note.tenantId, OWNER, "the subject is owned, so the writer stamps its tenant");

  await assert.rejects(() => saveNoteTheOldWay(note), (error: ForeignKeyViolation) => error.code === "P2003");

  // And on the constraint by name, so this is the outage and not merely an outage.
  await assert.rejects(
    async () => {
      legacyThread();
      await saveNoteTheOldWay(await typeANote({ leadId: LEAD }));
    },
    /Foreign key constraint violated on the constraint: `Communication_tenantId_conversationId_fkey`/,
  );
});

test("THE FIX: a message joining an unowned thread is unowned too, and is accepted", async () => {
  legacyThread();
  const note = await typeANote({ leadId: LEAD });
  assert.equal(note.tenantId, OWNER, "…still stamped from the subject when it reaches the hook");

  const written = await saveNote(note);

  assert.equal(written.conversationId, "conversation-legacy", "the message must still join its thread");
  assert.equal(
    written.tenantId,
    null,
    "the thread has no owner, so neither may the message on it — the FK parent decides, NULL included",
  );
  // The lead is owned and the message is not, and that is fine: MATCH SIMPLE stops
  // checking a key the moment one of its columns is NULL. The pair is claimed
  // together by the backfill, or not at all.
  assert.equal(written.leadId, LEAD);
});

/* ── 2. the owned thread, and the create path #475 fixed ───────────── */

test("a message joining an OWNED thread claims that thread's tenant", async () => {
  reset();
  tables.lead = [{ id: LEAD, tenantId: OWNER }];
  tables.conversation = [
    { id: "conversation-owned", channel: "note", status: "open", leadId: LEAD, tenantId: OWNER, lastMessageAt: 1 },
  ];

  const written = await saveNote(await typeANote({ leadId: LEAD }));
  assert.equal(written.conversationId, "conversation-owned");
  assert.equal(written.tenantId, OWNER, "an owned thread must not be joined by an unowned message");
});

test("a thread with an owner but a message with none is claimed BY the thread", async () => {
  // The nineteen callers all stamp today, but the hook must not depend on it: a
  // writer that says nothing about an owner gets the thread's, which is how the
  // unowned Communication rows on the 2026-08-10 audit stop being written.
  reset();
  tables.contact = [{ id: "contact-1", tenantId: OWNER }];
  tables.conversation = [
    { id: "conversation-owned", channel: "whatsapp", status: "open", contactId: "contact-1", tenantId: OWNER, lastMessageAt: 1 },
  ];

  const data: Row = { type: "whatsapp", contactId: "contact-1", body: "hi", userId: "user-1" };
  const written = await saveNote(data);
  assert.equal(written.tenantId, OWNER, "silence is not a claim to the contrary — the parent supplies one");
});

test("opening a NEW thread still takes the subject's owner, verbatim, including NULL", async () => {
  // #475's half of the rule, and it must stay: with no thread yet there is no FK
  // parent to inherit from, so the subject decides. Stamping the founding tenant
  // here is what `Conversation_tenantId_leadId_fkey` rejects — the fake enforces it.
  reset();
  tables.lead = [{ id: "lead-legacy", tenantId: null }];
  const unowned = await saveNote({ type: "note", leadId: "lead-legacy", body: "x", userId: "user-1", tenantId: null });
  assert.equal((tables.conversation ?? [])[0]?.tenantId, null, "an unowned subject opens an unowned thread");
  assert.equal(unowned.tenantId, null);

  reset();
  tables.contact = [{ id: "contact-1", tenantId: OWNER }];
  const owned = await saveNote({ type: "note", contactId: "contact-1", body: "x", userId: "user-1", tenantId: OWNER });
  assert.equal((tables.conversation ?? [])[0]?.tenantId, OWNER, "an owned subject opens an owned thread");
  assert.equal(owned.tenantId, OWNER);
});

/* ── 3. the contradiction ──────────────────────────────────────────── */

test("a thread and a subject in DIFFERENT workspaces refuse the write rather than launder it", async () => {
  // Genuinely contradictory, and unlike the NULL case there is no value that works:
  // the subject's violates the conversation key, the thread's violates the lead key,
  // and NULL satisfies both only by switching both OFF — writing a cross-tenant row
  // the database is no longer allowed to object to. `agreedTenantId` refuses this
  // pair for the same reason (#475) and so does this.
  reset();
  tables.lead = [{ id: LEAD, tenantId: OWNER }];
  tables.conversation = [
    { id: "conversation-elsewhere", channel: "note", status: "open", leadId: LEAD, tenantId: OTHER, lastMessageAt: 1 },
  ];

  const note = await typeANote({ leadId: LEAD });
  await assert.rejects(() => saveNote(note), (error: Error) => {
    assert.ok(error instanceof TenantParentConflictError, `refused for the wrong reason: ${error.message}`);
    assert.match(error.message, new RegExp(OWNER));
    assert.match(error.message, new RegExp(OTHER));
    return true;
  });
  assert.equal(tables.communication, undefined, "and nothing may be written on the way to refusing");
});

test("a caller that supplied its own thread is never handed another thread's owner", async () => {
  reset();
  tables.lead = [{ id: LEAD, tenantId: OWNER }];
  tables.conversation = [
    { id: "conversation-legacy", channel: "note", status: "open", leadId: LEAD, tenantId: null, lastMessageAt: 1 },
    { id: "conversation-chosen", channel: "note", status: "open", leadId: LEAD, tenantId: OWNER, lastMessageAt: 0 },
  ];

  const data = await typeANote({ leadId: LEAD, conversationId: "conversation-chosen" });
  const written = await saveNote(data);
  assert.equal(written.conversationId, "conversation-chosen", "the caller's choice stands");
  assert.equal(
    written.tenantId,
    OWNER,
    "the resolver would have found the legacy thread; its NULL must not reach a row pointing elsewhere",
  );
});

/* ── 4. the defect this replaced must not come back ────────────────── */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shipped = (rel: string) =>
  readFileSync(path.join(root, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("the message's owner is inherited from the parent row, never invented", () => {
  const code = shipped("src/lib/conversations.ts");
  assert.match(
    code,
    /data\.tenantId = attachedTenantId\(conversation\.tenantId, data\.tenantId\)/,
    "the thread's tenant is the input; anything else is a guess",
  );
  for (const invented of [/writeTenantId\(/, /DEFAULT_TENANT_ID/, /\?\? DEFAULT_TENANT_ID/]) {
    assert.doesNotMatch(
      code,
      invented,
      "resolving a stamp from the rollout state or the founding tenant collapses every workspace onto Denago while enforcement is dormant — the defect this replaced",
    );
  }
  // The resolver has to ASK for the column it decides on.
  assert.match(code, /select: \{ id: true, tenantId: true \}/);
});

test("the create hook takes the threading decision once, and before the INSERT", () => {
  const hook = shipped("src/lib/db.ts");
  const create = hook.slice(hook.indexOf("communication: {"), hook.indexOf("});", hook.indexOf("communication: {")));
  const attach = create.indexOf("attachToConversation(args.data)");
  const insert = create.indexOf("await query(args)");
  assert.ok(attach > -1 && insert > -1, "the hook must attach and then insert");
  assert.ok(attach < insert, "a tenant decided after the INSERT is a tenant that never reached the row");
  assert.doesNotMatch(
    create,
    /catch\s*\{[^}]*\}\s*const conversation/,
    "the attachment must not be wrapped in a catch — a refused tenant is a decision, not bookkeeping",
  );
});
