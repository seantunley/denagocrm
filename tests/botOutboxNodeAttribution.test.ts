/**
 * A DELIVERY FAILURE MUST NAME THE NODE WHOSE MESSAGE DIED.
 *
 * `BotFlowOutbox` carried `flowVersionId` but no origin node, so when a message
 * exhausted its retries the `delivery_failed` analytics event was recorded with a
 * version and a null node. The bot-analytics dashboard reports both: the version
 * total was right while the per-node column read zero for every node. That is
 * worse than a gap — it says "no node is failing" at the moment one is.
 *
 * The failures are never spread evenly across a graph. It is one image node whose
 * URL a provider rejects, or one choice node whose option list is too long for a
 * channel. Without the origin there is nothing to point at.
 *
 * This runs the SHIPPED chain end to end against an in-memory queue: the real
 * engine emits the messages, the real writer turns them into rows, and the real
 * worker fails one until it is dead-lettered. Nothing here scans source.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Module, { createRequire } from "node:module";
import { runFlow, type Flow, type FlowCtx } from "../src/lib/flow";

type Loader = (
  this: unknown,
  request: string,
  parent: { filename?: string } | undefined,
  isMain: boolean,
) => unknown;

const TENANT = "tenant_denago_cpt";

type Row = Record<string, unknown> & { id: string; attempts: number; status: string };

/** Every row the shipped writer created, in insertion order. */
const rows: Row[] = [];
/** Every analytics event the shipped worker recorded. */
const events: Array<Record<string, unknown>> = [];
/** Provider outcome for the next send. */
let providerResult: { ok: boolean; error?: string } = { ok: false, error: "Provider rejected chatbot message" };

/**
 * Only the `where` shapes botOutbox.ts actually writes are understood. Anything
 * else THROWS rather than silently matching nothing — a fake that quietly returns
 * "no rows" would make this test pass while proving nothing.
 */
function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [field, condition] of Object.entries(where)) {
    if (field === "OR") {
      const branches = condition as Record<string, unknown>[];
      if (!branches.some((branch) => matches(row, branch))) return false;
      continue;
    }
    const value = row[field];
    if (condition === null) {
      if (value !== null && value !== undefined) return false;
    } else if (typeof condition === "object" && condition !== null && !(condition instanceof Date)) {
      const test_ = condition as Record<string, unknown>;
      const keys = Object.keys(test_);
      for (const key of keys) {
        if (key === "in") { if (!(test_.in as unknown[]).includes(value)) return false; }
        else if (key === "notIn") { if ((test_.notIn as unknown[]).includes(value)) return false; }
        else if (key === "not") { if (value === test_.not) return false; }
        else if (key === "lte") { if (!(value instanceof Date) || value > (test_.lte as Date)) return false; }
        else if (key === "lt") { if (value === null || value === undefined) return false; if (!(value instanceof Date) || value >= (test_.lt as Date)) return false; }
        else if (key === "gt") { if (!(value instanceof Date) || value <= (test_.gt as Date)) return false; }
        else if (key === "OR") { if (!(test_.OR as Record<string, unknown>[]).some((branch) => matches(row, branch))) return false; }
        else throw new Error(`Unsupported outbox predicate: ${field}.${key}`);
      }
    } else if (value !== condition) return false;
  }
  return true;
}

function applyData(row: Row, data: Record<string, unknown>) {
  for (const [field, value] of Object.entries(data)) {
    if (value && typeof value === "object" && "increment" in (value as Record<string, unknown>)) {
      row[field] = (row[field] as number) + ((value as { increment: number }).increment);
    } else row[field] = value;
  }
}

const botFlowOutbox = {
  create: async ({ data }: { data: Record<string, unknown> }) => {
    // The real column is `@default(cuid())`; without an id here every row would
    // look identical to the lease's `where: { id: row.id }` and the claim would
    // match more than one, so nothing would ever be claimed.
    rows.push({ status: "pending", attempts: 0, leaseUntil: null, sentAt: null, lastError: null, communicationLoggedAt: null, id: `row-${rows.length + 1}`, ...data } as Row);
  },
  // Reads return DETACHED copies, as Prisma does. The lease is fenced on the
  // attempts value the reader saw, so handing back the live object would let a
  // later increment rewrite the caller's snapshot and break the fence.
  findFirst: async ({ where }: { where: Record<string, unknown> }) => {
    const row = rows.find((candidate) => matches(candidate, where));
    return row ? { ...row } : null;
  },
  findMany: async ({ where }: { where: Record<string, unknown> }) => rows.filter((row) => matches(row, where)).map((row) => ({ ...row })),
  updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    const hit = rows.filter((row) => matches(row, where));
    for (const row of hit) applyData(row, data);
    return { count: hit.length };
  },
};

const fakePrisma = { botFlowOutbox, communication: { upsert: async () => ({}) } };

const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only" || request === "client-only") return {};
  const from = parent?.filename ?? "";
  const outbox = from.endsWith("botOutbox.ts") || from.endsWith("botOutboxWrite.ts");
  if (!outbox) return realLoad.call(this, request, parent, isMain);

  // The worker and the writer are the units under test. Everything they reach for
  // outside themselves is replaced, anchored on the REQUESTING file so no stub can
  // leak into a module that merely imports the same thing.
  if (request === "./db") return { prisma: fakePrisma, basePrisma: fakePrisma };
  if (request === "./tenantWrite") {
    return {
      writeTenantId: () => TENANT,
      withTenantWrite: async (fn: (tx: unknown, tenantId: string) => Promise<unknown>) => fn(fakePrisma, TENANT),
    };
  }
  if (request === "./botFlowAnalytics") {
    return { recordBotFlowEvents: async (batch: Array<Record<string, unknown>>) => { events.push(...batch); } };
  }
  if (request === "./botSessionStore") return { markBotSessionDeliveryFailedTx: async () => {} };
  if (request === "./errorLog") return { logError: async () => {} };
  if (request === "./whatsapp") {
    return {
      sendWhatsAppText: async () => providerResult,
      sendWhatsAppImage: async () => providerResult,
      sendWhatsAppButtons: async () => providerResult,
      sendWhatsAppList: async () => providerResult,
    };
  }
  if (request === "./messenger") {
    return {
      sendDirectMessage: async () => providerResult,
      sendDirectAttachment: async () => providerResult,
      sendDirectQuickReplies: async () => providerResult,
    };
  }
  if (request === "./telegramTransport") return { tgSend: async () => providerResult, tgSendPhoto: async () => providerResult };
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const require_ = createRequire(import.meta.url);
const outboxWrite = require_("../src/lib/botOutboxWrite.ts") as typeof import("../src/lib/botOutboxWrite");
const outbox = require_("../src/lib/botOutbox.ts") as typeof import("../src/lib/botOutbox");

/** Eight is MAX_ATTEMPTS: claiming this row takes it to the attempt that dead-letters. */
const LAST_ATTEMPT = 7;

function reset() {
  rows.length = 0;
  events.length = 0;
  providerResult = { ok: false, error: "Provider rejected chatbot message" };
}

const baseCtx: FlowCtx = {
  aiReply: async () => ({ reply: "AI", handoff: false }),
  dynamicAnswer: async () => "dynamic",
  createBooking: async () => {},
  handoff: async () => {},
};

const FLOW: Flow = {
  start: "greet",
  nodes: {
    greet: { id: "greet", type: "message", text: "Hi there", next: "showCart" },
    showCart: { id: "showCart", type: "image", url: "https://example.test/cart.jpg", caption: "The Rover XL", next: "menu" },
    menu: { id: "menu", type: "choice", text: "What next?", options: [{ id: "prices", label: "Prices", next: "end" }] },
    end: { id: "end", type: "end" },
  },
};

test("the durable row records the flow node that produced its message", async () => {
  reset();
  const result = await runFlow(FLOW, { nodeId: null, vars: {} }, { text: "" }, baseCtx);
  await outboxWrite.enqueueBotMessagesTx(fakePrisma as never, TENANT, {
    channel: "whatsapp",
    key: "27821234567",
    messages: result.messages,
    flowVersionId: "version-1",
  });

  assert.deepEqual(rows.map((row) => row.nodeId), ["greet", "showCart", "menu"]);
  assert.deepEqual(rows.map((row) => row.flowVersionId), ["version-1", "version-1", "version-1"]);
});

test("a Meta image and its split-out caption stay attributed to the one node that emitted them", async () => {
  // Messenger/Instagram cannot send a captioned image, so the writer splits it in
  // two. Both halves are one node's output and they die together — attributing
  // only one of them would under-count the node that is actually failing.
  reset();
  const result = await runFlow(FLOW, { nodeId: null, vars: {} }, { text: "" }, baseCtx);
  await outboxWrite.enqueueBotMessagesTx(fakePrisma as never, TENANT, {
    channel: "messenger",
    key: "psid-1",
    messages: result.messages,
    flowVersionId: "version-1",
  });

  assert.deepEqual(rows.map((row) => row.nodeId), ["greet", "showCart", "showCart", "menu"]);
  assert.deepEqual(
    rows.map((row) => (row.payload as { type: string }).type),
    ["text", "image", "text", "choice"],
  );
});

test("a message that exhausts its retries attributes the failure to its node", async () => {
  reset();
  const result = await runFlow(FLOW, { nodeId: null, vars: {} }, { text: "" }, baseCtx);
  await outboxWrite.enqueueBotMessagesTx(fakePrisma as never, TENANT, {
    channel: "whatsapp",
    key: "27821234567",
    messages: result.messages,
    flowVersionId: "version-1",
  });
  // The image node is the one the provider keeps rejecting. Its two predecessors
  // went out fine, which is exactly the situation a per-node column has to show.
  rows[0].status = "sent";
  const failing = rows[1];
  failing.attempts = LAST_ATTEMPT;

  const run = await outbox.flushBotOutboxConversation("whatsapp", "27821234567");

  assert.equal(run.dead, 1, "the message must be dead-lettered, not retried again");
  assert.equal(failing.status, "dead");
  assert.equal(events.length, 1, "exactly one terminal failure is recorded");
  assert.equal(events[0].eventType, "delivery_failed");
  assert.equal(events[0].flowVersionId, "version-1");
  assert.equal(events[0].nodeId, "showCart", "the dashboard must be able to name the node whose message died");
  assert.equal(events[0].conversationKey, "27821234567");
});

test("a retry that has not exhausted its attempts records nothing to attribute", async () => {
  // The event marks a TERMINAL failure. Recording one per attempt would inflate
  // the failing node's count eightfold.
  reset();
  const result = await runFlow(FLOW, { nodeId: null, vars: {} }, { text: "" }, baseCtx);
  await outboxWrite.enqueueBotMessagesTx(fakePrisma as never, TENANT, {
    channel: "whatsapp",
    key: "27821234567",
    messages: result.messages,
    flowVersionId: "version-1",
  });

  const run = await outbox.flushBotOutboxConversation("whatsapp", "27821234567");
  assert.equal(run.retried, 1);
  assert.equal(rows[0].status, "retry");
  assert.deepEqual(events, []);
});

test("a row enqueued before the origin node existed still reports its failure, attributed to nothing", async () => {
  // Legacy rows have no nodeId. They must not be dropped from the version total,
  // and a null must read as "origin unknown" rather than being grouped as if
  // those failures shared a node — the node query excludes nulls for that reason.
  reset();
  rows.push({
    id: "legacy-1",
    tenantId: TENANT,
    channel: "whatsapp",
    key: "27821234567",
    batchId: "batch-legacy",
    sequence: 0,
    payload: { type: "text", text: "Hi there" },
    flowVersionId: "version-1",
    nodeId: null,
    contactId: null,
    leadId: null,
    actorId: null,
    status: "pending",
    attempts: LAST_ATTEMPT,
    availableAt: new Date(Date.now() - 1000),
    leaseUntil: null,
    createdAt: new Date(Date.now() - 1000),
    communicationLoggedAt: null,
  });

  await outbox.flushBotOutboxConversation("whatsapp", "27821234567");
  assert.equal(events.length, 1);
  assert.equal(events[0].nodeId, null);
  assert.equal(events[0].flowVersionId, "version-1");
});

test("delivery that succeeds records no failure against the node", async () => {
  reset();
  providerResult = { ok: true };
  const result = await runFlow(FLOW, { nodeId: null, vars: {} }, { text: "" }, baseCtx);
  await outboxWrite.enqueueBotMessagesTx(fakePrisma as never, TENANT, {
    channel: "whatsapp",
    key: "27821234567",
    messages: result.messages,
    flowVersionId: "version-1",
  });

  const run = await outbox.flushBotOutboxConversation("whatsapp", "27821234567");
  assert.equal(run.sent, 3);
  assert.deepEqual(events, []);
  assert.deepEqual(rows.map((row) => row.status), ["sent", "sent", "sent"]);
});
