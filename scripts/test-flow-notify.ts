/**
 * The chatbot's "Tell someone" step on a real database (round-2 flow builder, 2026-11-04): the chosen member gets an
 * Ask-history entry (source flow_notify), the customer's record logs it naming only the person, and someone outside
 * the workspace gets nothing.
 *
 *   npm run test:flow-notify      (DATABASE_URL = a disposable, migrated, seeded database)
 */
import assert from "node:assert/strict";

process.env.TENANT_ENFORCEMENT ||= "enforce";
delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;
const run = Date.now();
let checks = 0;
const ok = (label: string) => console.log(`  ✓ ${++checks}. ${label}`);

(async () => {
  const { basePrisma } = await import("../src/lib/db");
  const { runInTenantScope } = await import("../src/lib/tenantScope");
  const { notifyStaffFromFlow } = await import("../src/lib/flowNotify");

  const member = await basePrisma.tenantMember.findFirstOrThrow({ where: { user: { role: "owner" } }, select: { tenantId: true, userId: true, user: { select: { name: true } } } });
  const tenantId = member.tenantId;
  const contact = await basePrisma.contact.create({ data: { tenantId, firstName: "Notify", lastName: `Test-${run}` }, select: { id: true } });
  const text = `Thandi ${run} just asked for the price list`;
  const tell = (userId: string) => runInTenantScope({ tenantId, system: false }, () => notifyStaffFromFlow("WhatsApp", { userId, text }, { contactId: contact.id, leadId: null }));

  // 1. A member who may see customer conversations is told.
  const result = await tell(member.userId);
  assert.equal(result.ok, true, result.reason);
  const turn = await basePrisma.assistantTurn.findFirst({ where: { tenantId, userId: member.userId, source: "flow_notify", answer: { contains: text } }, select: { answer: true } });
  assert.ok(turn, "an Ask-history entry for them");
  assert.match(turn.answer, new RegExp(`/contacts/${contact.id}`), "with a link to the customer");
  ok("the chosen person gets it in their Ask history, linked to the customer");

  // 2. Logged on the customer's record — the person's name, never the customer's words.
  const audit = await basePrisma.auditLog.findMany({ where: { contactId: contact.id, action: "chatbot.notify" }, select: { summary: true } });
  const summaries = audit.map((row) => row.summary);
  assert.ok(summaries.length > 0, "logged on the customer's record");
  assert.ok(summaries.every((summary) => summary.includes(member.user.name) && !summary.includes(text)));
  ok("logged on the customer's record, naming the person and not what the customer said");

  // 3. Someone who is not in this workspace gets nothing.
  const before = await basePrisma.assistantTurn.count({ where: { source: "flow_notify" } });
  const refused = await tell(`not-a-member-${run}`);
  assert.equal(refused.ok, false);
  assert.equal(await basePrisma.assistantTurn.count({ where: { source: "flow_notify" } }), before);
  ok("someone outside the workspace is not told");

  // 4. The same inbound message delivered twice (WhatsApp redelivers): one alert, not two (PR #982 review).
  const { withInboundBotEvent } = await import("../src/lib/botInboundEvent");
  const { crmActions } = await import("../src/lib/flowActions");
  const again = `Redelivered ${run}`;
  const deliver = () =>
    runInTenantScope({ tenantId, system: false }, () =>
      withInboundBotEvent({ rowId: `test-event-${run}`, leaseAttempt: null }, () =>
        crmActions("whatsapp", { contactId: contact.id, leadId: null }).notifyStaff({ userId: member.userId, text: again, nodeId: "tell" })));
  assert.equal((await deliver()).ok, true);
  assert.equal((await deliver()).ok, true, "the retry is a success — it was already done");
  assert.equal(await basePrisma.assistantTurn.count({ where: { source: "flow_notify", answer: { contains: again } } }), 1);
  const alerts = await basePrisma.auditLog.count({ where: { contactId: contact.id, action: "chatbot.notify" } });
  assert.equal(alerts, 2, "logged once for this event (plus once for check 1)");
  ok("the same message delivered twice tells the person once — no second Ask entry, push or WhatsApp update");

  // Leave nothing waiting: later steps sweep this workspace's undelivered updates and count who they reach.
  await basePrisma.assistantTurn.updateMany({ where: { source: "flow_notify", OR: [{ answer: { contains: text } }, { answer: { contains: again } }] }, data: { whatsappSentAt: new Date() } });

  console.log(`\n${checks} checks passed`);
  await basePrisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
