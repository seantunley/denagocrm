/**
 * REAL-DATABASE proof that Meta's echo of our own message is not written into
 * the customer's history a second time — including in the window the provider id
 * alone cannot cover.
 *
 * Meta echoes every message the Page sends. The echo of OUR send is told apart by
 * the id Meta returned when it accepted it, which the delivery worker stores
 * against the row it delivered. The pure tests exercise that rule; what they
 * cannot show is the ordering that makes it insufficient:
 *
 *   worker                          webhook
 *   ──────                          ───────
 *   POST /me/messages
 *   Meta accepts, returns mid.1
 *                                   echo(mid.1) arrives
 *                                   ledger has no id yet → duplicate written
 *   UPDATE ... providerMessageId
 *
 * The gap is one database round trip. This script reproduces it by leaving a row
 * `running` with a null id — exactly the state the worker is in while at the
 * provider — and firing the echo at it, then checks that no second outbound row
 * was written. It then asserts the opposite case still works: a colleague's reply
 * from the Facebook Page inbox IS recorded, because the alternative trades
 * duplicate history for missing history.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes
 * every row it creates.
 */
import { basePrisma } from "../src/lib/db";
import { recordDmEcho } from "../src/lib/messenger";
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
  createdAt?: Date;
  /** When the worker claimed it — a live lease is in the future. */
  leaseUntil?: Date | null;
  sentAt?: Date | null;
}) {
  queued += 1;
  return basePrisma.botFlowOutbox.create({
    data: {
      tenantId: DEFAULT_TENANT_ID,
      channel: "messenger",
      key: PSID,
      batchId: `batch_${SFX}_${queued}`,
      sequence: 0,
      payload: { type: "text", text: opts.text },
      status: opts.status,
      providerMessageId: opts.providerMessageId,
      origin: "staff",
      // Defaults that mirror what claimOldest and deliverClaimed actually write,
      // so a row in this state is a row the worker could really have produced.
      leaseUntil:
        opts.leaseUntil !== undefined
          ? opts.leaseUntil
          : opts.status === "running"
          ? new Date(Date.now() + 60_000)
          : null,
      sentAt: opts.sentAt !== undefined ? opts.sentAt : opts.status === "sent" ? new Date() : null,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
    select: { id: true },
  });
}

const outboundCount = () =>
  basePrisma.communication.count({ where: { contactId: ids.contact, type: "messenger", direction: "outbound" } });

async function main() {
  guardEnvironment();
  await cleanup();
  await seed();

  // ── 1. THE ORDINARY CASE: THE LEDGER ALREADY HAS THE ID ───────────────────
  await queue({ text: "Reconciled reply", status: "sent", providerMessageId: "mid.reconciled" });
  await recordDmEcho("messenger", PSID, "Reconciled reply", "mid.reconciled");
  check("an echo whose id the ledger holds is not recorded", (await outboundCount()) === 0);

  // ── 2. THE RACE: ACCEPTED BY META, ID NOT YET WRITTEN ─────────────────────
  //
  // `running` with a null id is exactly the state the worker is in between Meta
  // accepting the send and the UPDATE that stores the id. Before this fix the
  // echo arriving here wrote a duplicate.
  await queue({ text: "In flight reply", status: "running", providerMessageId: null });
  await recordDmEcho("messenger", PSID, "In flight reply", "mid.inflight");
  check("an echo arriving before the id is stored is not recorded", (await outboundCount()) === 0);

  // Same, with no id on the echo at all — Meta does not always populate `mid`.
  await queue({ text: "No mid reply", status: "running", providerMessageId: null });
  await recordDmEcho("messenger", PSID, "No mid reply", null);
  check("an echo with no provider id is not recorded either", (await outboundCount()) === 0);

  // ── 3. A COLLEAGUE ON THE PAGE IS STILL RECORDED ──────────────────────────
  //
  // The failure mode on the other side. Dropping every echo would lose replies
  // sent from Business Suite, which the CRM has no other way of learning about.
  await recordDmEcho("messenger", PSID, "Typed in Business Suite", "mid.colleague");
  check("an echo we cannot claim IS recorded", (await outboundCount()) === 1);
  const recorded = await basePrisma.communication.findFirst({
    where: { contactId: ids.contact, direction: "outbound" },
    select: { body: true },
  });
  check("and it is the colleague's words", recorded?.body === "Typed in Business Suite", recorded?.body);

  // ── 4. A RECONCILED ROW CANNOT ABSORB A DIFFERENT MESSAGE'S ECHO ──────────
  //
  // The narrowing condition on the fallback. Once a row carries an id, an echo
  // with the same text and a different id is a genuinely different message.
  await queue({ text: "Same words", status: "sent", providerMessageId: "mid.ours" });
  await recordDmEcho("messenger", PSID, "Same words", "mid.theirs");
  check("identical text with a different id is recorded", (await outboundCount()) === 2);

  // ── 5. THE WINDOW IS A WINDOW ─────────────────────────────────────────────
  //
  // An old unreconciled row must not suppress today's echo for ever, or a single
  // failed send silences that sentence on that conversation permanently. The
  // clock is the ATTEMPT, so this is a row whose attempt was long ago.
  await queue({
    text: "Ancient greeting",
    status: "sent",
    providerMessageId: null,
    createdAt: new Date(Date.now() - 24 * 3600_000),
    sentAt: new Date(Date.now() - 24 * 3600_000),
  });
  await recordDmEcho("messenger", PSID, "Ancient greeting", null);
  check("an echo matching only a long-past ATTEMPT is recorded", (await outboundCount()) === 3);

  // ── 5b. A LONG WAIT IN THE QUEUE IS NOT A LONG-PAST ATTEMPT ───────────────
  //
  // THE REGRESSION THE REVIEW ASKED FOR. Queued at 10:00, worker unavailable for
  // twenty minutes, claimed and sent at 10:20, Meta accepts and emits the echo
  // before providerMessageId is committed. The row is in flight AT THIS MOMENT
  // and its createdAt is twenty minutes old — a window measured from creation
  // excluded it, so the outage the queue survived produced the duplicate the
  // queue exists to prevent.
  await queue({
    text: "Queued before the outage",
    status: "running",
    providerMessageId: null,
    createdAt: new Date(Date.now() - 20 * 60_000),
    leaseUntil: new Date(Date.now() + 60_000), // claimed just now
  });
  await recordDmEcho("messenger", PSID, "Queued before the outage", "mid.after-outage");
  check(
    "an echo for a row queued long ago but SENT just now is recognised",
    (await outboundCount()) === 3,
    `${await outboundCount()} outbound rows`,
  );

  // The same row an hour later, its lease long lapsed and never reconciled: that
  // is not an attempt in progress, and an echo arriving then is somebody else's.
  await queue({
    text: "Abandoned attempt",
    status: "running",
    providerMessageId: null,
    createdAt: new Date(Date.now() - 90 * 60_000),
    leaseUntil: new Date(Date.now() - 60 * 60_000),
  });
  await recordDmEcho("messenger", PSID, "Abandoned attempt", null);
  check("an echo matching only a lapsed lease is recorded", (await outboundCount()) === 4);

  // ── 6. ANOTHER TENANT'S SEND CANNOT SUPPRESS THIS ONE ─────────────────────
  await basePrisma.botFlowOutbox.create({
    data: {
      tenantId: ids.otherTenant,
      channel: "messenger",
      key: PSID,
      batchId: `batch_other_${SFX}`,
      sequence: 0,
      payload: { type: "text", text: "Cross tenant" },
      status: "running",
      providerMessageId: null,
      leaseUntil: new Date(Date.now() + 60_000),
      origin: "staff",
    },
  });
  await recordDmEcho("messenger", PSID, "Cross tenant", null);
  check("a matching row in ANOTHER tenant does not suppress the echo", (await outboundCount()) === 5);

  // ── 7. THE ECHO DOES NOT RESURRECT AN ARCHIVED THREAD ─────────────────────
  //
  // Pre-existing behaviour, re-checked because the guard above now runs before
  // it and an early return in the wrong place would skip it silently.
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
