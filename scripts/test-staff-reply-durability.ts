/**
 * A STAFF REPLY IS ONE DECISION, AND IT EITHER HAPPENED OR IT DID NOT.
 *
 * The source tests can assert that the ledger has a `failureCode` column and that
 * the writes share a transaction. They cannot show that any runtime path ever
 * SETS that column, or that a duplicate submission finds the bot already paused,
 * or that automation output queued before a person answered never reaches the
 * customer. Those are behaviours, and a real database is the only thing that can
 * demonstrate them.
 *
 * What this proves, in order:
 *
 *   1. replying takes the conversation over — the BotSession is paused and the
 *      bot's unsent backlog is withdrawn, in the same commit as the reply;
 *   2. the timeline row and the delivery record are linked, so the inbox can
 *      report what became of the message instead of assuming it left;
 *   3. a resubmission of the same composition writes nothing and resolves to the
 *      message it duplicates;
 *   4. an EDITED resubmission is a different message and actually sends — the
 *      failure a box-scoped idempotency key produced, which delivered the typo;
 *   5. a cancelled message does not become an unclaimable queue head, which would
 *      silence the conversation for ever;
 *   6. a permanent failure is classified, stored, and acted on — one attempt, not
 *      eight.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes
 * every row it creates.
 */
import { basePrisma, prisma } from "../src/lib/db";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";
import {
  deliveryStateForMessages,
  enqueueBotMessages,
  enqueueStaffMessage,
  flushBotOutboxConversation,
} from "../src/lib/botOutbox";
import { staffReplyIdempotencyKey } from "../src/lib/messageDelivery";

const SFX = Math.random().toString(16).slice(2, 10);
let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function guardEnvironment() {
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  const name = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) {
    throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
  }
}

const ids = {
  user: `u_staff_${SFX}`,
  contact: `c_staff_${SFX}`,
  /** The customer's WhatsApp identity — the conversation key. */
  wa: `2782${SFX.replace(/\D/g, "").padEnd(7, "1").slice(0, 7)}`,
  /** A channel no adapter supports, so a send fails permanently without a network call. */
  deadChannel: `nosuch_${SFX}`,
  deadKey: `k_${SFX}`,
};

const composition = `comp_${SFX}`;
const BODY = "Thanks — your unit is ready for collection.";

const keyFor = (body: string) =>
  staffReplyIdempotencyKey({ compositionId: composition, channel: "whatsapp", key: ids.wa, body });

async function seed() {
  // The founding tenant is created by migration; make sure it is there rather
  // than assuming, since every write below is stamped with it.
  await basePrisma.tenant.upsert({
    where: { id: DEFAULT_TENANT_ID },
    update: {},
    create: { id: DEFAULT_TENANT_ID, name: "Founding", slug: DEFAULT_TENANT_ID, active: true },
  });
  await basePrisma.user.create({
    data: {
      id: ids.user,
      name: "Reply tester",
      email: `${ids.user}@example.test`,
      passwordHash: "x",
      role: "admin",
      tenantId: DEFAULT_TENANT_ID,
    },
  });
  await basePrisma.contact.create({
    data: { id: ids.contact, firstName: "Staff", whatsapp: ids.wa, createdById: ids.user, tenantId: DEFAULT_TENANT_ID },
  });
}

async function cleanup() {
  await basePrisma.botFlowOutbox.deleteMany({
    where: { OR: [{ key: ids.wa }, { key: ids.deadKey }] },
  });
  await basePrisma.botSession.deleteMany({ where: { key: { in: [ids.wa, ids.deadKey] } } });
  await basePrisma.communication.deleteMany({ where: { contactId: ids.contact } });
  // AuditEvent is append-only at the DATABASE level — a trigger refuses DELETE.
  // That is the point of an audit trail and this test does not get to be an
  // exception, so the one row it writes is left behind. It is attributed to a
  // per-run actor id, so it can never be confused with another run's, and the
  // database this may only run against is disposable by construction.
  //
  // The legacy AuditLog table has no such trigger but does hold an FK to Contact,
  // so it has to go before the contact does.
  await basePrisma.auditLog.deleteMany({ where: { contactId: ids.contact } });
  await basePrisma.contact.deleteMany({ where: { id: ids.contact } });
  await basePrisma.user.deleteMany({ where: { id: ids.user } });
}

const reply = (body: string) =>
  enqueueStaffMessage({
    channel: "whatsapp",
    key: ids.wa,
    message: { type: "text", text: body },
    clientIdempotencyKey: keyFor(body),
    body,
    contactId: ids.contact,
    actorId: ids.user,
    audit: {
      action: "whatsapp.sent",
      summary: `WhatsApp sent to +${ids.wa}`,
      user: { id: ids.user, name: "Reply tester" },
    },
  });

async function main() {
  guardEnvironment();
  await seed();

  // ── The bot is mid-conversation with this customer ────────────────────────
  await enqueueBotMessages({
    channel: "whatsapp",
    key: ids.wa,
    messages: [{ type: "text", text: "bot line 1" }, { type: "text", text: "bot line 2" }],
    contactId: ids.contact,
  });

  // ── A person answers ──────────────────────────────────────────────────────
  const first = await reply(BODY);
  check("the reply is accepted and recorded", first.created && Boolean(first.communicationId));

  const session = await basePrisma.botSession.findFirst({
    where: { tenantId: DEFAULT_TENANT_ID, channel: "whatsapp", key: ids.wa },
    select: { status: true, ownership: true },
  });
  check(
    "replying pauses the bot for that conversation",
    session?.status === "paused",
    `session status: ${session?.status ?? "none"}`,
  );
  // Stronger than paused: nothing the customer types hands the thread back, only
  // an explicit Return to bot. Replying by hand is the same claim Take over
  // makes, so it has to record the same ownership.
  check(
    "and records that a PERSON owns it, not merely that the bot is quiet",
    session?.ownership === "human",
    `ownership: ${session?.ownership ?? "none"}`,
  );

  const botRows = await basePrisma.botFlowOutbox.findMany({
    where: { tenantId: DEFAULT_TENANT_ID, key: ids.wa, origin: "bot" },
    select: { status: true, failureCode: true },
  });
  check(
    "the bot's unsent backlog is withdrawn, not left to arrive after the human answer",
    botRows.length === 2 && botRows.every((row) => row.status === "cancelled"),
    JSON.stringify(botRows),
  );
  check(
    "and it says why it will never be sent",
    botRows.every((row) => row.failureCode === "superseded_by_human"),
    JSON.stringify(botRows),
  );

  const staffRow = await basePrisma.botFlowOutbox.findFirst({
    where: { tenantId: DEFAULT_TENANT_ID, key: ids.wa, origin: "staff" },
    select: { id: true, status: true, communicationId: true, communicationLoggedAt: true },
  });
  check(
    "the person's own reply is NOT cancelled with the bot's",
    staffRow?.status === "pending",
    `staff row status: ${staffRow?.status ?? "none"}`,
  );
  check(
    "the delivery record and the timeline row are linked",
    Boolean(staffRow?.communicationId) && staffRow?.communicationId === first.communicationId,
    `outbox.communicationId=${staffRow?.communicationId} communication=${first.communicationId}`,
  );
  check(
    "the reply is pre-stamped as logged, so the worker cannot log it again as bot output",
    Boolean(staffRow?.communicationLoggedAt),
  );

  const audits = await basePrisma.auditEvent.count({ where: { actorUserId: ids.user } });
  check("the trail committed with the decision it describes", audits === 1, `${audits} audit rows`);

  // The inbox can now answer the question it could not before.
  const state = (await deliveryStateForMessages([first.communicationId!])).get(first.communicationId!);
  check(
    "the inbox can see the message has not been delivered yet",
    state?.status === "pending",
    `delivery state: ${JSON.stringify(state)}`,
  );

  // ── The same composition, resubmitted ─────────────────────────────────────
  const again = await reply(BODY);
  check("a resubmission of the same message writes nothing new", !again.created);
  check(
    "and resolves to the message it duplicates, so the person can be told its real state",
    again.communicationId === first.communicationId,
    `${again.communicationId} vs ${first.communicationId}`,
  );
  const afterDuplicate = await basePrisma.communication.count({ where: { contactId: ids.contact } });
  check("the customer's history still holds exactly one copy", afterDuplicate === 1, `${afterDuplicate} rows`);

  // ── The person corrects a typo and sends again ────────────────────────────
  //
  // The failure a box-scoped key produced: the key was unchanged, so the
  // correction was discarded as a duplicate and the customer received the
  // original. The corrected text must be a different message.
  const corrected = await reply(`${BODY} See you at 9.`);
  check("an edited resubmission is a different message and actually sends", corrected.created);
  check(
    "the correction is its own timeline row",
    corrected.communicationId !== first.communicationId,
    `${corrected.communicationId} vs ${first.communicationId}`,
  );

  // ── A cancelled message must not become an unclaimable queue head ─────────
  //
  // The bot rows were queued BEFORE the staff reply, so they sort ahead of it.
  // If `cancelled` did not count as finished, the conversation's queue head
  // would be a row that can never be claimed and nothing would ever send again.
  const queueHead = await basePrisma.botFlowOutbox.findFirst({
    where: { tenantId: DEFAULT_TENANT_ID, key: ids.wa, status: { notIn: ["sent", "dead", "cancelled"] } },
    orderBy: [{ createdAt: "asc" }, { sequence: "asc" }, { id: "asc" }],
    select: { origin: true },
  });
  check(
    "a cancelled message does not block the queue behind it",
    queueHead?.origin === "staff",
    `queue head origin: ${queueHead?.origin ?? "none"}`,
  );

  // ── A permanent failure is classified, stored and ACTED ON ────────────────
  //
  // An unsupported channel fails identically on every attempt, so spending eight
  // of them over two hours is pure delay. This is the runtime path that writes
  // failureCode; without it the column was decoration.
  await enqueueBotMessages({
    channel: ids.deadChannel,
    key: ids.deadKey,
    messages: [{ type: "text", text: "undeliverable" }],
  });
  const run = await flushBotOutboxConversation(ids.deadChannel, ids.deadKey);
  const failedRow = await basePrisma.botFlowOutbox.findFirst({
    where: { tenantId: DEFAULT_TENANT_ID, key: ids.deadKey },
    select: { status: true, failureCode: true, attempts: true, lastError: true },
  });
  check("a permanently undeliverable message is dead-lettered", run.dead === 1 && failedRow?.status === "dead", JSON.stringify({ run, failedRow }));
  check(
    "the failure is classified on the row, not merely logged",
    failedRow?.failureCode === "invalid_payload",
    `failureCode: ${failedRow?.failureCode}`,
  );
  check(
    "and the classification is acted on — one attempt, not eight",
    failedRow?.attempts === 1,
    `attempts: ${failedRow?.attempts}`,
  );
}

main()
  .then(async () => {
    await cleanup();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  })
  .catch(async (error) => {
    await cleanup().catch(() => {});
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
    await basePrisma.$disconnect();
  });
