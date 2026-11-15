import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  BURST_CHARS,
  BURST_LEASE_MS,
  BURST_QUIET_MS,
  burstTurn,
  joinedQuestion,
  sentAtFrom,
  type WaitingMessage,
} from "../src/lib/assistantWhatsAppBurst";

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** Sean, 2026-11-15: a shared contact, "New lead" and an email inside three seconds were answered at once, each blind. */
const t0 = Date.parse("2026-11-15T09:59:29Z");
const row = (messageId: string, text: string, sentS: number, extra: Partial<WaitingMessage> = {}): WaitingMessage => ({
  messageId, text, sentAt: new Date(t0 + sentS * 1000), createdAt: new Date(t0 + sentS * 1000 + 300), claimedBy: null, claimedAt: null, ...extra,
});

test("the three messages are one question, in the order they were sent — not the order they reached us", () => {
  const rows = [
    row("m3", "Dereklallyett@gmail.com", 3),
    row("m1", "I've shared a contact from my phone. Add them to the CRM as a new customer.\n\nName: Derek Lallyett", 0),
    row("m2", "New lead", 1),
  ];
  assert.equal(
    joinedQuestion(rows),
    "I've shared a contact from my phone. Add them to the CRM as a new customer.\n\nName: Derek Lallyett\nNew lead\nDereklallyett@gmail.com",
  );
  // Same second (Meta's timestamp is whole seconds): the one that reached us first goes first.
  const same = [row("b", "second", 5, { createdAt: new Date(t0 + 5_900) }), row("a", "first", 5, { createdAt: new Date(t0 + 5_100) })];
  assert.equal(joinedQuestion(same), "first\nsecond");
});

test("only the newest waiting message answers; older ones hand over; a taken one is gone", () => {
  const rows = [row("m1", "a", 0), row("m2", "b", 1), row("m3", "c", 3)];
  const now = t0 + 10_000;
  assert.equal(burstTurn(rows, "m1", now), "handed");
  assert.equal(burstTurn(rows, "m2", now), "handed");
  assert.equal(burstTurn(rows, "m3", now), "answer");
  assert.equal(burstTurn([row("m1", "a", 0, { claimedBy: "m3", claimedAt: new Date(now) })], "m1", now), "gone", "taken by another answer");
  assert.equal(burstTurn([], "m1", now), "gone", "removed");
});

test("a later message waits while an earlier answer of theirs runs — unless that answer died", () => {
  const now = t0 + 60_000;
  const running = row("m1", "a", 0, { claimedBy: "m1", claimedAt: new Date(now - 20_000) });
  assert.equal(burstTurn([running, row("m4", "next", 50)], "m4", now), "wait");
  const dead = { ...running, claimedAt: new Date(now - BURST_LEASE_MS - 1) };
  assert.equal(burstTurn([dead, row("m4", "next", 50)], "m4", now), "answer");
});

test("a long burst keeps its newest words; the wait is a few seconds; an unreadable timestamp is now", () => {
  const long = joinedQuestion([row("m1", "x".repeat(BURST_CHARS), 0), row("m2", "the newest words", 1)]);
  assert.ok(long.endsWith("the newest words"));
  assert.equal(long.length, BURST_CHARS + 1);
  assert.ok(BURST_QUIET_MS >= 3_000 && BURST_QUIET_MS <= 4_000, "measured: 3.3 s joins, 5.2 s stays apart");
  assert.equal(sentAtFrom("1763200769").getTime(), 1763200769_000);
  assert.equal(sentAtFrom(undefined, 42).getTime(), 42);
  assert.equal(sentAtFrom("nope", 42).getTime(), 42);
});

test("wiring: only typed messages wait; every read names workspace and person; released however the answer ends", () => {
  const wa = src("src/lib/assistantWhatsApp.ts");
  // After the confirm buttons, the typed "yes", the ask limit and the photo/file/voice handling — before the answer.
  const at = wa.indexOf("const burst = await joinBurst(");
  assert.ok(at > wa.indexOf("answerYes(input.text)") && at > wa.indexOf("assistantAskAllowed(user.id)") && at < wa.indexOf("await askCrm(user, q"));
  assert.match(wa, /if \("text" in input && !input\.choiceId && messageId\) \{\s*const burst = await joinBurst\(tenantId, user\.id, messageId, q, sentAtFrom\(opts\.sentAt\)\);/);
  const join = wa.slice(wa.indexOf("async function joinBurst"));
  for (const m of join.matchAll(/waiting\.(findMany|updateMany|deleteMany)\(\{ where: \{ ([^}]*)\}/g)) {
    assert.match(m[2], /^tenantId[,\s]/, m[0]);
  }
  assert.match(wa, /const run = async \(\) => \{\s*try \{\s*return await answer\(\);\s*\} finally \{\s*await releaseBurst\?\.\(\)\.catch\(\(\) => \{\}\);/);
  assert.match(wa, /opts\.defer\(async \(\) => \{ await run\(\); \}\);/);
  const route = src("src/app/api/webhooks/whatsapp/route.ts");
  assert.equal((route.match(/\{ defer, sentAt: message\.timestamp \}/g) ?? []).length, 2, "typed text and a shared contact");
  const migration = src("prisma/migrations/20261115120000_assistant_whatsapp_waiting/migration.sql");
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM|UPDATE "|ALTER TABLE "(?!AssistantWhatsAppWaiting)/);
});
