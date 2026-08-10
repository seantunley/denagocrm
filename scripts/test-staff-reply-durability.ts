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
import { sendOutcomeMessage, staffReplyIdempotencyKey } from "../src/lib/messageDelivery";
import { pauseBotConversation } from "../src/lib/botConversationControl";

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
  /** A conversation of its own for the takeover fence, so nothing else blocks its drain. */
  fenceKey: `2782${SFX.replace(/\D/g, "").padEnd(7, "2").slice(0, 7)}9`,
};

const composition = `comp_${SFX}`;
const BODY = "Thanks — your unit is ready for collection.";

const keyFor = (body: string, overrides: { actorId?: string; contactId?: string | null } = {}) =>
  staffReplyIdempotencyKey({
    compositionId: composition,
    channel: "whatsapp",
    key: ids.wa,
    actorId: overrides.actorId ?? ids.user,
    contactId: overrides.contactId === undefined ? ids.contact : overrides.contactId,
    leadId: null,
    body,
  });

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
    where: { OR: [{ key: ids.wa }, { key: ids.deadKey }, { key: ids.fenceKey }] },
  });
  await basePrisma.botSession.deleteMany({ where: { key: { in: [ids.wa, ids.deadKey, ids.fenceKey] } } });
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

  // ── A key that resolves to a DIFFERENT send is a conflict ─────────────────
  //
  // With every identity field in the key this needs a hash collision, so it is
  // forced here by submitting the first message's key alongside different
  // content. The point is what happens when a key stops describing its send:
  // answering "already sent" would discard the reply the person actually typed
  // and attribute somebody else's message to them.
  const conflicting = await enqueueStaffMessage({
    channel: "whatsapp",
    key: ids.wa,
    message: { type: "text", text: "Sorry, we don't have stock" },
    clientIdempotencyKey: keyFor(BODY), // the FIRST message's key, different body
    body: "Sorry, we don't have stock",
    contactId: ids.contact,
    actorId: ids.user,
  });
  check(
    "a key that resolves to a different send is refused, not treated as a duplicate",
    conflicting.outcome === "conflict",
    `outcome: ${conflicting.outcome}`,
  );
  check(
    "and reports no ids, so nothing can be claimed about somebody else's message",
    conflicting.communicationId === null && conflicting.outboxId === null,
    JSON.stringify(conflicting),
  );
  const afterConflict = await basePrisma.communication.count({ where: { contactId: ids.contact } });
  check(
    "a conflict writes nothing",
    afterConflict === 2,
    `${afterConflict} rows, expected the original plus the correction`,
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

  // ── ZERO BOT MESSAGES AFTER TAKEOVER, WHATEVER THE BOT WAS DOING ─────────
  //
  // Cancelling the pending queue at takeover does not prove this property, which
  // is why it is tested separately. Two states survive that cancel:
  //
  //   a) a flow turn that STARTED before takeover and commits after it — the AI
  //      call takes seconds, and the person presses Take over during it;
  //   b) a row a worker had already CLAIMED, which takeover deliberately does not
  //      touch because its lease belongs to that worker.
  //
  // Both must end with the bot silent. Its own conversation, so the assertion is
  // about the fence and not about whatever else is queued: a staff reply sitting
  // ahead in the queue would block the drain before it ever reached these rows.
  await enqueueBotMessages({
    channel: "whatsapp",
    key: ids.fenceKey,
    messages: [{ type: "text", text: "in flight when the person took over" }, { type: "text", text: "and the line after it" }],
    contactId: ids.contact,
  });

  // The person takes the conversation over. No staff message is queued here —
  // Take over is a claim of ownership on its own, and the fence must hold for it.
  await pauseBotConversation({ channel: "whatsapp", key: ids.fenceKey }, 12);
  const owned = await basePrisma.botSession.findFirst({
    where: { tenantId: DEFAULT_TENANT_ID, channel: "whatsapp", key: ids.fenceKey },
    select: { ownership: true },
  });
  check("taking over records that a person owns the conversation", owned?.ownership === "human", `ownership: ${owned?.ownership}`);

  // (b) One row was already CLAIMED when that happened — the state takeover
  // cannot withdraw — and its worker then died, leaving the lease to expire.
  const inFlight = await basePrisma.botFlowOutbox.findFirst({
    where: { tenantId: DEFAULT_TENANT_ID, key: ids.fenceKey, origin: "bot" },
    orderBy: { sequence: "asc" },
    select: { id: true, status: true },
  });
  check(
    "a claimed row survives takeover's cancel, exactly as designed",
    inFlight?.status === "cancelled" || inFlight?.status === "pending",
    `status: ${inFlight?.status}`,
  );
  await basePrisma.botFlowOutbox.updateMany({
    where: { id: inFlight!.id },
    data: { status: "running", attempts: 1, leaseUntil: new Date(Date.now() - 60_000), failureCode: null },
  });

  // The drain runs. Nothing here may reach the provider.
  const afterTakeover = await flushBotOutboxConversation("whatsapp", ids.fenceKey);
  const fenceRows = await basePrisma.botFlowOutbox.findMany({
    where: { tenantId: DEFAULT_TENANT_ID, key: ids.fenceKey, origin: "bot" },
    select: { status: true, failureCode: true },
  });
  check(
    "a bot message claimed before takeover is withdrawn at the delivery gate, not sent",
    fenceRows.every((row) => row.status === "cancelled"),
    JSON.stringify(fenceRows),
  );
  check(
    "and says it was superseded by a person, not that it failed",
    fenceRows.every((row) => row.failureCode === "superseded_by_human"),
    JSON.stringify(fenceRows),
  );
  check(
    "the drain reports it as cancelled rather than delivered",
    afterTakeover.cancelled >= 1 && afterTakeover.sent === 0,
    JSON.stringify(afterTakeover),
  );
  // "None are marked sent" is too weak on its own — this environment has no
  // provider credentials, so nothing could be delivered even unfenced. The
  // property is that the provider was never CALLED, and a provider-derived
  // failure code is the evidence that it was: without the fence these rows come
  // back `retry` / `not_configured`, which only a real send attempt produces.
  const botSent = await basePrisma.botFlowOutbox.count({
    where: { tenantId: DEFAULT_TENANT_ID, key: ids.fenceKey, origin: "bot", status: "sent" },
  });
  check("ZERO bot-origin messages were sent after the takeover", botSent === 0, `${botSent} bot messages sent`);
  check(
    "and none of them reached the provider at all",
    fenceRows.every((row) => row.failureCode === "superseded_by_human"),
    `a provider-derived failure code means the send was attempted: ${JSON.stringify(fenceRows)}`,
  );

  // The fence is about OWNERSHIP, not about silencing a conversation: the
  // person's own replies elsewhere are untouched.
  const staffStillQueued = await basePrisma.botFlowOutbox.count({
    where: { tenantId: DEFAULT_TENANT_ID, key: ids.wa, origin: "staff", status: { notIn: ["cancelled", "dead"] } },
  });
  check("the person's own replies are not cancelled with the bot's", staffStillQueued > 0, `${staffStillQueued} staff rows live`);

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

  // ── What the person is told after a real provider rejection ──────────────
  //
  // The action drains before it reads the state, so by the time it answers, the
  // provider has usually already refused. Reporting that in green — "Queued —
  // sending…" — is the original "Sent ✓" defect in a quieter voice: the person
  // moves on and the customer never hears from them.
  const deadState = (
    await deliveryStateForMessages(
      (
        await basePrisma.botFlowOutbox.findMany({
          where: { tenantId: DEFAULT_TENANT_ID, key: ids.deadKey },
          select: { communicationId: true },
        })
      )
        .map((row) => row.communicationId)
        .filter((id): id is string => Boolean(id)),
    )
  ).size;
  // Bot rows carry no communicationId, so there is nothing to look up — which is
  // itself correct, and the assertion below is the one that matters.
  check("a bot row has no timeline link to mis-report", deadState === 0);

  const outcome = sendOutcomeMessage({
    status: failedRow!.status,
    failureCode: failedRow!.failureCode,
    attempts: failedRow!.attempts,
  });
  check(
    "a message the provider refused is reported as not sent, from the REAL row",
    Boolean(outcome.error) && !outcome.ok,
    JSON.stringify(outcome),
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
