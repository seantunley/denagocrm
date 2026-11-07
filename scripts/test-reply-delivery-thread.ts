/**
 * REAL-DATABASE proof that only a DELIVERED reply answers a waiting customer.
 *
 * 2026-11-07: DAX said "no one has answered yet" about a customer who had been
 * answered. The fix files staff replies on the customer's conversation — which
 * makes the opposite mistake possible: a reply the provider then REFUSES would
 * mark the customer answered. Conversation.lastDirection (read by DAX's waiting
 * alert and the attention list) and the inbox's "Reply due" (settleAwaiting) must
 * both treat a queued, retrying or failed reply as no answer, and agree.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes
 * every row it creates.
 */
import { basePrisma } from "../src/lib/db";
import { recomputeConversationDerivedState } from "../src/lib/conversations";
import { buildInboxThreads, settleAwaiting, turnUndecided } from "../src/lib/inboxThreads";
import { olderTurns } from "../src/lib/inboxQuery";
import { runInTenantScope } from "../src/lib/tenantScope";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";

const SFX = Math.random().toString(16).slice(2, 10);
const tenantId = DEFAULT_TENANT_ID;
const contactId = `c_reply_${SFX}`;
const userId = `u_reply_${SFX}`;
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
  if (!/_test$/.test(name)) throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
}

async function cleanup() {
  const comms = await basePrisma.communication.findMany({ where: { contactId }, select: { id: true } });
  await basePrisma.botFlowOutbox.deleteMany({ where: { communicationId: { in: comms.map((c) => c.id) } } });
  await basePrisma.communication.deleteMany({ where: { contactId } });
  await basePrisma.conversation.deleteMany({ where: { contactId } });
  await basePrisma.contact.deleteMany({ where: { id: contactId } });
  await basePrisma.user.deleteMany({ where: { id: userId } });
}

async function main() {
  guardEnvironment();
  await cleanup();
  await basePrisma.user.create({ data: { id: userId, name: "Staff", email: `staff.${SFX}@example.test`, passwordHash: "x", role: "sales" } });
  await basePrisma.contact.create({ data: { id: contactId, tenantId, firstName: "Waiting", lastName: SFX, whatsapp: `2798${SFX.slice(0, 7)}` } });
  const conversation = await basePrisma.conversation.create({ data: { tenantId, channel: "whatsapp", contactId } });
  const at = (minutes: number) => new Date(Date.UTC(2026, 10, 7, 10, minutes));
  await basePrisma.communication.create({
    data: { tenantId, type: "whatsapp", direction: "inbound", body: "Yes, please", contactId, userId, conversationId: conversation.id, occurredAt: at(0) },
  });
  const reply = await basePrisma.communication.create({
    data: { tenantId, type: "whatsapp", direction: "outbound", body: "On its way", contactId, userId, conversationId: conversation.id, occurredAt: at(5) },
  });
  const outbox = await basePrisma.botFlowOutbox.create({
    data: { tenantId, channel: "whatsapp", key: `2798${SFX}`, batchId: `b_${SFX}`, sequence: 0, origin: "staff", payload: { type: "text", text: "On its way" }, status: "pending", communicationId: reply.id },
  });

  // The three surfaces: DAX's alert and the attention list read lastDirection; the inbox reads settleAwaiting.
  async function surfaces() {
    await recomputeConversationDerivedState(conversation.id);
    const row = await basePrisma.conversation.findUniqueOrThrow({ where: { id: conversation.id }, select: { lastDirection: true } });
    const comms = await basePrisma.communication.findMany({
      where: { contactId },
      orderBy: { occurredAt: "desc" },
      include: { contact: true, lead: { select: { name: true, phone: true } } },
    });
    const statuses = new Map(
      (await basePrisma.botFlowOutbox.findMany({ where: { communicationId: { in: comms.map((c) => c.id) } }, select: { communicationId: true, status: true } }))
        .map((o) => [o.communicationId as string, o.status]),
    );
    const status = (id: string) => statuses.get(id);
    // The inbox page's own steps: the preview (newest 8 per thread), then older turns for undecided threads.
    const threads = buildInboxThreads(comms as never);
    const older = await runInTenantScope({ tenantId, system: false }, () => olderTurns(threads.filter((t) => turnUndecided(t, status))));
    const [thread] = settleAwaiting(threads, status, older);
    return { conversationWaiting: row.lastDirection === "inbound", inboxWaiting: thread?.awaiting === true };
  }

  for (const state of ["pending", "running", "retry", "dead", "cancelled"]) {
    await basePrisma.botFlowOutbox.update({ where: { id: outbox.id }, data: { status: state } });
    const s = await surfaces();
    check(`a ${state} reply leaves the customer waiting — conversation (DAX, attention)`, s.conversationWaiting);
    check(`a ${state} reply leaves the customer waiting — inbox Reply due`, s.inboxWaiting);
  }

  await basePrisma.botFlowOutbox.update({ where: { id: outbox.id }, data: { status: "sent" } });
  let s = await surfaces();
  check("a delivered reply answers them — conversation", !s.conversationWaiting);
  check("a delivered reply answers them — inbox", !s.inboxWaiting);

  // Accepted, then reported failed by the provider (sent → dead): waiting again.
  await basePrisma.botFlowOutbox.update({ where: { id: outbox.id }, data: { status: "dead" } });
  s = await surfaces();
  check("sent then failed: waiting again — conversation", s.conversationWaiting);
  check("sent then failed: waiting again — inbox", s.inboxWaiting);

  // The Attention Centre times the wait from THEIR message: a failed reply 3h later must not restart it.
  const times = await basePrisma.conversation.findUniqueOrThrow({ where: { id: conversation.id }, select: { lastInboundAt: true, lastMessageAt: true } });
  check("a failed reply leaves lastInboundAt at the customer's message", times.lastInboundAt?.getTime() === at(0).getTime(), String(times.lastInboundAt));

  // Nine failed replies in a row push the customer's message out of the inbox's 8-message preview.
  const more = [];
  for (let i = 1; i <= 9; i++) {
    const extra = await basePrisma.communication.create({
      data: { tenantId, type: "whatsapp", direction: "outbound", body: `Retry ${i}`, contactId, userId, conversationId: conversation.id, occurredAt: at(10 + i) },
    });
    more.push(extra.id);
    await basePrisma.botFlowOutbox.create({
      data: { tenantId, channel: "whatsapp", key: `2798${SFX}`, batchId: `b_${SFX}`, sequence: i, origin: "staff", payload: { type: "text", text: `Retry ${i}` }, status: "dead", communicationId: extra.id },
    });
  }
  s = await surfaces();
  check("nine failed replies: still waiting — conversation", s.conversationWaiting);
  check("nine failed replies: still waiting — inbox (beyond the 8-message preview)", s.inboxWaiting);
  await basePrisma.botFlowOutbox.deleteMany({ where: { communicationId: { in: more } } });
  await basePrisma.communication.deleteMany({ where: { id: { in: more } } });

  // A reply with no outbox row (logged by hand, an email) stands as written.
  await basePrisma.botFlowOutbox.delete({ where: { id: outbox.id } });
  s = await surfaces();
  check("a reply with no outbox row answers them — conversation", !s.conversationWaiting);
  check("a reply with no outbox row answers them — inbox", !s.inboxWaiting);
}

main()
  .catch((error) => {
    failed++;
    console.error(error);
  })
  .finally(async () => {
    await cleanup().catch(() => {});
    await basePrisma.$disconnect();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  });
