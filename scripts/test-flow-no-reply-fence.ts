/**
 * "If no reply within…" on a real database (round-2 flow builder; PR #988 review):
 *
 * 1. THE CLAIM — a timeout is taken in one locked transaction BEFORE any step runs (claimNoReplyTx): once only; not
 *    when the customer answered first (deadline gone or re-armed), not when a person took over; a claim abandoned by
 *    a crash can be taken again after 10 minutes, a fresh one cannot. And the final fence reads the claim marker.
 * 2. A JOURNEY FROM A TIMEOUT — a Start Journey step on the no-reply route runs under the timeout's own identity
 *    (noReplyEventId), so it enrols the customer — and a second attempt at the same timeout enrols nobody again.
 *
 *   npm run test:flow-no-reply-fence      (DATABASE_URL = a disposable, migrated, seeded database)
 */
import assert from "node:assert/strict";

process.env.TENANT_ENFORCEMENT ||= "enforce";
const run = Date.now();
let checks = 0;
const ok = (label: string) => console.log(`  ✓ ${++checks}. ${label}`);

(async () => {
  const { basePrisma } = await import("../src/lib/db");
  const { runInTenantScope } = await import("../src/lib/tenantScope");
  const { botSessionStillWaitingTx, claimNoReplyTx } = await import("../src/lib/botSessionStore");
  const { withInboundBotEvent } = await import("../src/lib/botInboundEvent");
  const { crmActions } = await import("../src/lib/flowActions");
  const flowNoReply = await import("../src/lib/flowNoReply");
  const { NO_REPLY_AT, NO_REPLY_CLAIMED, NO_REPLY_CLAIMED_AT, NO_REPLY_RECLAIM_MS, noReplyEventId } = flowNoReply;

  const user = await basePrisma.user.findFirstOrThrow({ where: { tenantId: { not: null } }, select: { tenantId: true } });
  const tenantId = user.tenantId!;
  const key = `2799${String(run).slice(-9)}`;
  const at = String(run + 30 * 60_000);
  const session = (vars: Record<string, string>, ownership = "bot") =>
    basePrisma.botSession.upsert({
      where: { tenantId_channel_key: { tenantId, channel: "whatsapp", key } },
      create: { tenantId, channel: "whatsapp", key, nodeId: "menu", vars: JSON.stringify(vars), status: "active", ownership, expiresAt: new Date(run + 86_400_000) },
      update: { nodeId: "menu", vars: JSON.stringify(vars), ownership },
    });
  const stored = async () => JSON.parse((await basePrisma.botSession.findFirstOrThrow({ where: { tenantId, channel: "whatsapp", key } })).vars) as Record<string, string>;
  const claim = (now = Date.now()) =>
    basePrisma.$transaction((tx) => claimNoReplyTx(tx as never, tenantId, "whatsapp", key, {
      nodeId: "menu", at, atKey: NO_REPLY_AT, claimedKey: NO_REPLY_CLAIMED, claimedAtKey: NO_REPLY_CLAIMED_AT, now, reclaimMs: NO_REPLY_RECLAIM_MS,
    }));
  const fence = () => basePrisma.$transaction((tx) => botSessionStillWaitingTx(tx as never, tenantId, "whatsapp", key, { nodeId: "menu", at, atKey: NO_REPLY_CLAIMED }));

  // ── 1. The claim ─────────────────────────────────────────────────────────
  await session({ [NO_REPLY_AT]: at, name: "Thandi" });
  assert.equal(await claim(), true);
  const after = await stored();
  assert.equal(after[NO_REPLY_AT], undefined, "the deadline is gone");
  assert.equal(after[NO_REPLY_CLAIMED], at);
  assert.equal(after.name, "Thandi", "the conversation's own values are kept");
  assert.equal(await fence(), true, "and the final fence recognises the claim");
  ok("a due timeout is claimed before anything runs; the fence recognises it");

  assert.equal(await claim(), false);
  ok("a second sweep at the same moment finds nothing to claim");

  await session({ [NO_REPLY_AT]: String(Number(at) + 60_000) });
  assert.equal(await claim(), false);
  await session({});
  assert.equal(await claim(), false);
  ok("a customer who answered first (re-armed, or no deadline left) wins: nothing is claimed, nothing runs");

  await session({ [NO_REPLY_AT]: at }, "human");
  assert.equal(await claim(), false);
  ok("a conversation a person took over is never claimed");

  await session({ [NO_REPLY_CLAIMED]: at, [NO_REPLY_CLAIMED_AT]: String(Date.now()) });
  assert.equal(await claim(), false, "a fresh claim belongs to the run that made it");
  assert.equal(await claim(Date.now() + NO_REPLY_RECLAIM_MS + 1_000), true, "an abandoned one (a crash) can be taken again");
  ok("a claim abandoned by a crash is taken again after 10 minutes, a fresh one is not");

  await session({ [NO_REPLY_CLAIMED]: at });
  await basePrisma.botSession.updateMany({ where: { tenantId, channel: "whatsapp", key }, data: { vars: JSON.stringify({}) } });
  assert.equal(await fence(), false);
  ok("a customer turn that cleared the claim mid-run makes the fence drop the timeout's reply");

  // ── 2. A Journey from a timeout ─────────────────────────────────────────────
  const contact = await basePrisma.contact.create({ data: { tenantId, firstName: "NoReply", lastName: `Test-${run}` }, select: { id: true } });
  const journey = await basePrisma.journey.create({ data: { tenantId, name: `No-reply journey ${run}`, status: "active", activeVersion: 1 }, select: { id: true } });
  await basePrisma.journeyVersion.create({
    data: { tenantId, journeyId: journey.id, version: 1, state: "published", triggers: [], trigger: "manual", definition: { startStepId: "w", steps: [{ id: "w", type: "wait", config: { amount: 1, unit: "days" } }] } },
  });
  const timeoutId = noReplyEventId(tenantId, key, "menu", at);
  const startFromTimeout = () =>
    runInTenantScope({ tenantId, system: false }, () =>
      withInboundBotEvent({ rowId: timeoutId, leaseAttempt: null }, () =>
        crmActions("whatsapp", { contactId: contact.id, leadId: null }).startJourney(journey.id, {}, "journeyStep")));
  const runs = () => basePrisma.journeyRun.count({ where: { journeyId: journey.id, entityId: contact.id } });

  const first = await startFromTimeout();
  assert.equal(first.ok, true, first.reason);
  assert.equal(await runs(), 1);
  ok("a Start Journey step on the no-reply route enrols the customer (the timeout has its own identity)");

  await startFromTimeout();
  assert.equal(await runs(), 1);
  ok("the same timeout attempted again (after a crash) enrols nobody twice");

  // ── 3. A reply AFTER the claim, BEFORE the action (PR #988 second review) ─────────────────────────
  // The timeout is claimed; its route is about to start a Journey; the customer's message lands first. Their turn
  // cancels the timeout (cancelNoReplyTx, as runWhatsAppFlow does first thing), and the timeout's action — run through
  // the real fence and the real chatbot action — finds its claim gone and does nothing.
  const { cancelNoReplyTx } = await import("../src/lib/botSessionStore");
  const { fenceTimeoutEffects, NO_REPLY_KEYS } = flowNoReply;
  const contact2 = await basePrisma.contact.create({ data: { tenantId, firstName: "NoReplyRace", lastName: `Test-${run}` }, select: { id: true } });
  const at2 = String(run + 60 * 60_000);
  const raceAction = async (customerWritesFirst: boolean) => {
    await session({ [NO_REPLY_AT]: at2 });
    const claimed = await basePrisma.$transaction((tx) => claimNoReplyTx(tx as never, tenantId, "whatsapp", key, {
      nodeId: "menu", at: at2, atKey: NO_REPLY_AT, claimedKey: NO_REPLY_CLAIMED, claimedAtKey: NO_REPLY_CLAIMED_AT, now: Date.now(), reclaimMs: NO_REPLY_RECLAIM_MS,
    }));
    assert.equal(claimed, true);
    if (customerWritesFirst) await basePrisma.$transaction((tx) => cancelNoReplyTx(tx as never, tenantId, "whatsapp", key, NO_REPLY_KEYS));
    return runInTenantScope({ tenantId, system: false }, () =>
      withInboundBotEvent({ rowId: noReplyEventId(tenantId, key, "menu", at2), leaseAttempt: null }, async () => {
        const actions = crmActions("whatsapp", { contactId: contact2.id, leadId: null });
        const fenced = fenceTimeoutEffects(actions as never, () =>
          basePrisma.$transaction((tx) => botSessionStillWaitingTx(tx as never, tenantId, "whatsapp", key, { nodeId: "menu", at: at2, atKey: NO_REPLY_CLAIMED })));
        const outcome = await actions.startJourney(journey.id, {}, "raceJourney");
        return { outcome, superseded: fenced.superseded() };
      }));
  };
  const runs2 = () => basePrisma.journeyRun.count({ where: { journeyId: journey.id, entityId: contact2.id } });
  const raced = await raceAction(true);
  assert.equal(raced.outcome.ok, false);
  assert.equal(raced.superseded, true, "the runner then drops the whole timeout turn");
  assert.equal(await runs2(), 0, "no Journey for a customer who wrote while the timeout was running");
  assert.deepEqual(Object.keys(await stored()).filter((k) => k.startsWith("__noreply")), [], "and the timeout is gone, not merely skipped");
  ok("a reply after the claim but before the action: the action does nothing, the timeout is dropped");
  const control = await raceAction(false);
  assert.equal(control.outcome.ok, true, control.outcome.reason);
  assert.equal(await runs2(), 1);
  ok("…and with no reply in between, the same fenced action does enrol (the fence isn't simply always shut)");

  await basePrisma.botSession.deleteMany({ where: { tenantId, channel: "whatsapp", key } });
  console.log(`\n${checks} checks passed`);
  await basePrisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
