/**
 * REAL-DATABASE proof that Meta's echo of our own message is reconciled away —
 * and that a colleague's message never is.
 *
 * Meta echoes every message the Page sends. The echo of OUR send is told apart
 * by the id Meta returned when it accepted it, which the delivery worker stores
 * against the row it delivered. But we only learn that id from the response to
 * our own send, and Meta dispatches the echo the moment it accepts, so the echo
 * can arrive and be handled BEFORE the worker commits it:
 *
 *   worker                          webhook
 *   ──────                          ───────
 *   POST /me/messages
 *   Meta accepts, returns mid.1
 *                                   echo(mid.1): ledger has no id yet
 *   UPDATE ... providerMessageId
 *
 * Guessing in that window from the message TEXT was the previous design, and it
 * was lossy: a colleague sending "Thanks" from Business Suite while the CRM was
 * sending "Thanks" lost their message permanently. So nothing is guessed. The
 * echo is RECORDED, and whichever side commits second removes the duplicate.
 *
 * That is a claim about ordering between two concurrent writers, which is
 * exactly what a source test cannot check. Every interleaving below is built
 * against a real database.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes
 * every row it creates.
 */
import { basePrisma } from "../src/lib/db";
import { recordDmEcho } from "../src/lib/messenger";
import { metaEchoDedupeKey } from "../src/lib/metaEcho";
import { deleteCommunicationsAndReconcile } from "../src/lib/conversations";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";

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
  const url = process.env.DATABASE_URL ?? "";
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Refusing to run outside NODE_ENV=test");
  }
  const name = url.split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) {
    throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
  }
}

const PSID = `psid_${SFX}`;
const ids = {
  contact: `c_echo_${SFX}`,
  user: `u_echo_${SFX}`,
  /** A second tenant, so "scoped" can be shown rather than asserted. */
  otherTenant: `tenant_other_${SFX}`,
};

async function seed() {
  await basePrisma.tenant.create({
    data: { id: ids.otherTenant, name: `Other Dealership ${SFX}`, slug: `other-${SFX}` },
  });
  await basePrisma.user.create({
    data: { id: ids.user, name: `Echo Tester ${SFX}`, email: `echo.${SFX}@example.test`, passwordHash: "x", role: "sales" },
  });
  await basePrisma.contact.create({
    data: { id: ids.contact, firstName: "Echo", lastName: `Customer ${SFX}`, messengerPsid: PSID },
  });
}

async function cleanup() {
  await basePrisma.botFlowOutbox.deleteMany({ where: { key: PSID } });
  await basePrisma.conversationNote.deleteMany({ where: { conversation: { contactId: ids.contact } } });
  await basePrisma.conversationDraft.deleteMany({ where: { conversation: { contactId: ids.contact } } });
  await basePrisma.communication.deleteMany({ where: { contactId: ids.contact } });
  await basePrisma.conversation.deleteMany({ where: { contactId: ids.contact } });
  await basePrisma.contact.deleteMany({ where: { id: ids.contact } });
  await basePrisma.auditLog.deleteMany({ where: { userId: ids.user } });
  await basePrisma.user.deleteMany({ where: { id: ids.user } });
  await basePrisma.tenant.deleteMany({ where: { id: ids.otherTenant } });
}

let queued = 0;
/** A delivery in whatever state the test needs, on this conversation. */
async function queue(opts: {
  text: string;
  status: string;
  providerMessageId: string | null;
  tenantId?: string;
}) {
  queued += 1;
  return basePrisma.botFlowOutbox.create({
    data: {
      tenantId: opts.tenantId ?? DEFAULT_TENANT_ID,
      channel: "messenger",
      key: PSID,
      batchId: `batch_${SFX}_${queued}`,
      sequence: 0,
      payload: { type: "text", text: opts.text },
      status: opts.status,
      providerMessageId: opts.providerMessageId,
      origin: "staff",
      leaseUntil: opts.status === "running" ? new Date(Date.now() + 60_000) : null,
      sentAt: opts.status === "sent" ? new Date() : null,
    },
    select: { id: true },
  });
}

/**
 * The Conversation projection, which is what the inbox actually reads for
 * ordering, pagination and "who is waiting on us".
 *
 * Asserting on Communication rows alone proves the duplicate DISAPPEARS. It does
 * not prove the system is back in the state it would have had if the duplicate
 * had never existed — and the guarded client rolls these counters forward on
 * every create while nothing intercepts a delete, so that gap is exactly where a
 * speculative row leaves a permanent trace.
 */
const projection = async () => {
  const conversation = await basePrisma.conversation.findFirst({
    where: { contactId: ids.contact, channel: "messenger" },
    select: { messageCount: true, lastDirection: true, lastInboundAt: true, firstResponseAt: true },
  });
  return JSON.stringify(conversation);
};

/**
 * `lastMessageAt` is checked as an INVARIANT rather than by comparing to a
 * captured baseline, because the two clocks differ by design.
 *
 * `bumpConversation` stamps `msg.occurredAt ?? new Date()` — and a create that
 * does not name occurredAt leaves it to the column default, so the conversation
 * records the application's clock while the row records the database's. They are
 * a fraction of a millisecond apart and never equal, which makes a captured
 * baseline impossible to match exactly and says nothing about the cleanup.
 *
 * The property that matters is the one recomputation restores: the conversation
 * says the last message arrived when the last surviving message actually did.
 */
const lastMessageAtTracksNewestRow = async () => {
  const conversation = await basePrisma.conversation.findFirst({
    where: { contactId: ids.contact, channel: "messenger" },
    select: { id: true, lastMessageAt: true },
  });
  if (!conversation) return false;
  const newest = await basePrisma.communication.findFirst({
    where: { conversationId: conversation.id },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    select: { occurredAt: true },
  });
  if (!newest) return false;
  return conversation.lastMessageAt.getTime() === newest.occurredAt.getTime();
};

/** Every message row is threaded; an unthreaded one is invisible to the panel. */
const unthreaded = () =>
  basePrisma.communication.count({ where: { contactId: ids.contact, conversationId: null } });

const outbound = () =>
  basePrisma.communication.findMany({
    where: { contactId: ids.contact, type: "messenger", direction: "outbound" },
    select: { id: true, body: true, messageId: true, dedupeKey: true },
    orderBy: { createdAt: "asc" },
  });
const outboundCount = async () => (await outbound()).length;

/**
 * What the worker does after the provider accepts: commit the id, then remove
 * the echo of the message it has just proved is ours. The delete is keyed, so it
 * addresses exactly one row.
 */
async function workerCommitsId(outboxId: string, providerMessageId: string) {
  await basePrisma.botFlowOutbox.update({
    where: { id: outboxId },
    data: { status: "sent", sentAt: new Date(), leaseUntil: null, providerMessageId },
  });
  // The SAME call the worker makes — deleteCommunicationsAndReconcile, not a bare
  // deleteMany. Reimplementing the cleanup here would test the test.
  await deleteCommunicationsAndReconcile({
    dedupeKey: metaEchoDedupeKey(DEFAULT_TENANT_ID, providerMessageId),
  });
}

async function main() {
  guardEnvironment();
  await cleanup();
  await seed();

  // A real CRM outbound, written the way the reply path writes one, so the
  // conversation exists and its counters are already rolled forward. Every
  // baseline below is taken against this.
  const { prisma } = await import("../src/lib/db");
  await prisma.communication.create({
    data: { type: "messenger", direction: "outbound", body: "Our real reply", contactId: ids.contact, userId: ids.user },
  });
  const BASELINE = await projection();
  check("the real reply is threaded and counted", JSON.parse(BASELINE).messageCount === 1, BASELINE);

  // ── 1. THE ECHO ARRIVES AFTER THE ID IS COMMITTED ─────────────────────────
  //
  // The ordinary case. Nothing is written at all.
  await queue({ text: "Reconciled reply", status: "sent", providerMessageId: "mid.reconciled" });
  await recordDmEcho("messenger", PSID, "Reconciled reply", "mid.reconciled");
  check("an echo whose id the ledger holds is never written", (await outboundCount()) === 1);
  check("and the projection is untouched", (await projection()) === BASELINE, await projection());

  // ── 2. THE ECHO ARRIVES FIRST — THE WORKER CLEANS UP ──────────────────────
  //
  // `running` with a null id is exactly the state the worker is in between Meta
  // accepting the send and the UPDATE that stores the id.
  const racing = await queue({ text: "In flight reply", status: "running", providerMessageId: null });
  await recordDmEcho("messenger", PSID, "In flight reply", "mid.inflight");
  const afterEcho = await outbound();
  check("an echo arriving before the id IS recorded, not guessed away", afterEcho.length === 2);
  const speculative = afterEcho.find((row) => row.body === "In flight reply");
  check(
    "and it carries the provider id, which is what makes it reconcilable",
    speculative?.messageId === "mid.inflight",
    speculative?.messageId ?? "null",
  );
  check(
    "keyed so the worker can address exactly this row",
    speculative?.dedupeKey === metaEchoDedupeKey(DEFAULT_TENANT_ID, "mid.inflight"),
    speculative?.dedupeKey ?? "null",
  );
  // THREADED. An upsert skipped the guarded client's create hook entirely, so the
  // row landed with a null conversationId — invisible to every conversation-scoped
  // query while looking perfectly fine on the timeline.
  check("and it is attached to the conversation like any other message", (await unthreaded()) === 0);
  check("the speculative row moves the projection while it exists", (await projection()) !== BASELINE);

  await workerCommitsId(racing.id, "mid.inflight");
  check("and the worker removes it once the id proves it was ours", (await outboundCount()) === 1);
  check(
    "AND puts the conversation back to the no-duplicate baseline",
    (await projection()) === BASELINE,
    await projection(),
  );
  check("with lastMessageAt back on the surviving message", await lastMessageAtTracksNewestRow());

  // ── 3. THE INTERLEAVING BETWEEN THE TWO ───────────────────────────────────
  //
  // The webhook read the ledger before the worker's update and wrote after the
  // worker's delete. Neither side is at fault and the duplicate would simply
  // stay — which is why the webhook re-reads after writing.
  const interleaved = await queue({ text: "Interleaved reply", status: "running", providerMessageId: null });
  await workerCommitsId(interleaved.id, "mid.interleaved"); // worker finishes first
  await recordDmEcho("messenger", PSID, "Interleaved reply", "mid.interleaved");
  check("an echo landing after the worker's cleanup does not survive", (await outboundCount()) === 1);
  check(
    "and its own re-check restores the baseline too",
    (await projection()) === BASELINE,
    await projection(),
  );
  check("with lastMessageAt back on the surviving message too", await lastMessageAtTracksNewestRow());

  // ── 4. A COLLEAGUE ON THE PAGE IS ALWAYS RETAINED ─────────────────────────
  //
  // THE CASE THAT MADE THE PREVIOUS DESIGN UNSOUND. We are sending "Thanks"
  // right now, id not yet committed. A colleague sends "Thanks" by hand from
  // Business Suite at the same moment. The old fallback saw identical text
  // against an in-flight row and dropped their message for ever.
  const sendingThanks = await queue({ text: "Thanks", status: "running", providerMessageId: null });
  await recordDmEcho("messenger", PSID, "Thanks", "mid.colleague-thanks");
  check("a colleague's IDENTICAL text is recorded while we are sending it", (await outboundCount()) === 2);

  // Our own send then completes with its own id. Their message must be untouched.
  await workerCommitsId(sendingThanks.id, "mid.ours-thanks");
  const survivors = await outbound();
  check("and survives our send completing", survivors.length === 2, `${survivors.length} rows`);
  const theirs = survivors.find((row) => row.body === "Thanks");
  check(
    "still theirs, still carrying their id",
    theirs?.messageId === "mid.colleague-thanks",
    JSON.stringify(theirs),
  );
  // And our OWN echo of the same words, arriving late, is still dropped.
  await recordDmEcho("messenger", PSID, "Thanks", "mid.ours-thanks");
  check("while our own echo of the same words is dropped", (await outboundCount()) === 2);
  // A RETAINED message must stay counted. The baseline moved by exactly one, and
  // it moved because a real message arrived — not because a cleanup missed one.
  const withColleague = JSON.parse(await projection());
  check(
    "and the colleague's message is counted, once",
    withColleague.messageCount === 2,
    JSON.stringify(withColleague),
  );
  const AFTER_COLLEAGUE = await projection();

  // ── 5. A REDELIVERED WEBHOOK IS A NO-OP ───────────────────────────────────
  //
  // Meta redelivers. Without the key this wrote a third copy each time.
  await recordDmEcho("messenger", PSID, "Thanks", "mid.colleague-thanks");
  await recordDmEcho("messenger", PSID, "Thanks", "mid.colleague-thanks");
  check("a redelivered echo does not multiply", (await outboundCount()) === 2);
  check(
    "and does not inflate the projection either",
    (await projection()) === AFTER_COLLEAGUE,
    await projection(),
  );

  // ── 6. AN ECHO WITH NO PROVIDER ID IS KEPT ────────────────────────────────
  //
  // It can never be correlated in either direction, so it can never be
  // reconciled. Keeping it is the deliberate trade: a duplicate is visible and
  // survivable; a silently discarded customer-facing message is neither.
  await queue({ text: "No mid at all", status: "running", providerMessageId: null });
  await recordDmEcho("messenger", PSID, "No mid at all", null);
  check("an echo with no provider id is recorded rather than guessed away", (await outboundCount()) === 3);

  // ── 7. ANOTHER TENANT'S SEND CANNOT CLAIM THIS ECHO ───────────────────────
  await queue({ text: "Cross tenant", status: "sent", providerMessageId: "mid.cross", tenantId: ids.otherTenant });
  await recordDmEcho("messenger", PSID, "Cross tenant", "mid.cross");
  check("a matching row in ANOTHER tenant does not suppress the echo", (await outboundCount()) === 4);
  check("every surviving row is threaded", (await unthreaded()) === 0);
  const counted = JSON.parse(await projection()).messageCount;
  check("and the projection counts exactly the surviving rows", counted === (await outboundCount()), `${counted}`);
  // No lastMessageAt assertion here on purpose: nothing was reconciled in this
  // section, so the value legitimately carries bumpConversation's own clock. The
  // invariant is asserted where a cleanup actually ran.

  // ── 8. THE ECHO DOES NOT RESURRECT AN ARCHIVED THREAD ─────────────────────
  //
  // Pre-existing behaviour, re-checked because the decision above now runs
  // before it and an early return in the wrong place would skip it silently.
  await basePrisma.communication.updateMany({
    where: { contactId: ids.contact },
    data: { archivedAt: new Date() },
  });
  await recordDmEcho("messenger", PSID, "After archiving", "mid.after-archive");
  const newest = await basePrisma.communication.findFirst({
    where: { contactId: ids.contact, body: "After archiving" },
    select: { archivedAt: true },
  });
  check("an echo into an archived thread stays archived", newest !== null && newest.archivedAt !== null);
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
  .finally(() => basePrisma.$disconnect());
