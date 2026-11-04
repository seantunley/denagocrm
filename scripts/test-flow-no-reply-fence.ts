/**
 * "If no reply within…" on a real database (round-2 flow builder, 2026-11-04): the sweep's fence — the session must
 * still be the bot's, on the same question, with the same deadline — read from the real BotSession row (vars is TEXT
 * holding JSON). A customer whose answer re-armed or moved the session, or a person who took over, wins.
 *
 *   npm run test:flow-no-reply-fence      (DATABASE_URL = a disposable, migrated, seeded database)
 */
import assert from "node:assert/strict";

const run = Date.now();
let checks = 0;
const ok = (label: string) => console.log(`  ✓ ${++checks}. ${label}`);

(async () => {
  const { basePrisma } = await import("../src/lib/db");
  const { botSessionStillWaitingTx } = await import("../src/lib/botSessionStore");
  const { NO_REPLY_AT } = await import("../src/lib/flowNoReply");

  const user = await basePrisma.user.findFirstOrThrow({ where: { tenantId: { not: null } }, select: { tenantId: true } });
  const tenantId = user.tenantId!;
  const key = `2700${run}`.slice(0, 15);
  const at = String(run + 30 * 60_000);
  await basePrisma.botSession.create({
    data: { tenantId, channel: "whatsapp", key, nodeId: "menu", vars: JSON.stringify({ [NO_REPLY_AT]: at, name: "Thandi" }), status: "active", ownership: "bot", expiresAt: new Date(run + 86_400_000) },
  });
  const fence = (expected: { nodeId: string; at: string }) =>
    basePrisma.$transaction((tx) => botSessionStillWaitingTx(tx as never, tenantId, "whatsapp", key, { ...expected, atKey: NO_REPLY_AT }));

  assert.equal(await fence({ nodeId: "menu", at }), true);
  ok("still waiting on that question with that deadline: the sweep may move it");

  assert.equal(await fence({ nodeId: "menu", at: String(Number(at) + 1) }), false);
  assert.equal(await fence({ nodeId: "ask", at }), false);
  ok("re-armed by an answer, or moved on: the sweep does nothing");

  await basePrisma.botSession.updateMany({ where: { tenantId, channel: "whatsapp", key }, data: { ownership: "human" } });
  assert.equal(await fence({ nodeId: "menu", at }), false);
  ok("a person took the conversation over: the sweep does nothing");

  await basePrisma.botSession.deleteMany({ where: { tenantId, channel: "whatsapp", key } });
  console.log(`\n${checks} checks passed`);
  await basePrisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
