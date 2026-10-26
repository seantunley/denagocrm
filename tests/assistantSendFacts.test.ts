import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { emailSendStatus, openedFact } from "../src/lib/emailOpenTracking";
import { receiptFact } from "../src/lib/deliveryReceipts";
import { watchNotification } from "../src/lib/assistantWatchRules";

/*
 * DAX roadmap, Phase 2: every lookup that talks about a send says what happened to it, in words the CRM can stand
 * behind. Email: accepted by our mail server / bounced / open detected / no open detected / can't tell — never
 * "delivered" or "read". WhatsApp / Messenger: the platform's own delivered / seen receipts.
 */

const at = new Date("2026-10-20T08:00:00Z");
const later = new Date("2026-10-21T08:00:00Z");

test("email wording: only what the CRM can know", () => {
  assert.equal(emailSendStatus({ occurredAt: at, messageId: "<m@x>", openToken: "t" }), "accepted by our mail server 2026-10-20; no open detected");
  assert.equal(emailSendStatus({ occurredAt: at, messageId: "<m@x>", openToken: "t", seenAt: later }), "accepted by our mail server 2026-10-20; open detected 2026-10-21");
  assert.equal(emailSendStatus({ occurredAt: at, messageId: "<m@x>" }), "accepted by our mail server 2026-10-20; can't tell whether it was opened");
  assert.equal(emailSendStatus({ occurredAt: at }), "recorded on the timeline 2026-10-20 — can't tell whether it was sent");
  for (const c of [{ occurredAt: at, messageId: "<m@x>", openToken: "t", seenAt: later }, { occurredAt: at, messageId: "<m@x>" }]) {
    assert.doesNotMatch(emailSendStatus(c), /\bdelivered\b|\bread\b|\breceived\b/i);
  }
});

test("a bounce wins over everything, keeps the server's reason and drops the address", () => {
  const s = emailSendStatus({ occurredAt: at, messageId: "<m@x>", openToken: "t", seenAt: later, bouncedAt: later, bounceReason: "werner@example.invalid: High probability of spam (550)" });
  assert.equal(s, "bounced 2026-10-21 — their mail server refused it (High probability of spam (550)), so they never got it; reach them another way");
  assert.doesNotMatch(s, /@/, "no customer address goes to the model");
  // The lead brief's own bounce fact too (it passed the stored "<address>: <reason>" through).
  const fact = openedFact({ type: "email", direction: "outbound", messageId: "<m@x>", bouncedAt: later, bounceReason: "werner@example.invalid: High probability of spam (550)" });
  assert.equal((fact as { notDelivered?: { reason: string | null } }).notDelivered?.reason, "High probability of spam (550)");
});

test("WhatsApp / Messenger receipts are read; email and inbound get none", () => {
  assert.deepEqual(receiptFact({ type: "whatsapp", direction: "outbound", deliveredAt: at, seenAt: later }), { receipt: "seen 2026-10-21" });
  assert.deepEqual(receiptFact({ type: "messenger", direction: "outbound", deliveredAt: at }), { receipt: "delivered to their phone 2026-10-20; no seen receipt (they may have them off)" });
  assert.deepEqual(receiptFact({ type: "whatsapp", direction: "outbound" }), { receipt: "no delivery receipt yet" });
  assert.deepEqual(receiptFact({ type: "email", direction: "outbound", seenAt: later }), {});
  assert.deepEqual(receiptFact({ type: "whatsapp", direction: "inbound", deliveredAt: at }), {});
});

test("the quote_unsigned note puts a bounced quote under its own heading, not 'still unsigned'", () => {
  const note = watchNotification({ kind: "quote_unsigned", thresholdHours: 48 }, [
    { ref: "Q-1042", customer: "Anna Jacobs" },
    { ref: "Q-1043", customer: "Werner Kilian", bounced: true },
  ]);
  assert.equal(note, [
    "✍️ Opened but not signed after 2 days:",
    "• Q-1042 — Anna Jacobs",
    "📭 Quote email bounced — they never got it, so reach them another way:",
    "• Q-1043 — Werner Kilian",
  ].join("\n"));
  const onlyBounced = watchNotification({ kind: "quote_unsigned" }, [{ ref: "Q-1043", customer: "Werner Kilian", bounced: true }]);
  assert.doesNotMatch(onlyBounced, /Opened but not signed/);
});

test("every lookup that talks about a send carries it (find_quotes, a lead's quotes, a customer's quotes, messages)", () => {
  const src = readFileSync(new URL("../src/lib/crmAssistant.ts", import.meta.url), "utf8");
  assert.equal(src.match(/sendStatus: sends\.get\((quote|q)\.id\)!\.status/g)?.length, 3);
  assert.match(src, /\.\.\.receiptFact\(c\),/);
  assert.match(src, /deliveredAt: true,/);
  const watch = readFileSync(new URL("../src/lib/assistantWatch.ts", import.meta.url), "utf8");
  assert.match(watch, /const sends = await quoteSends\(open\);/);
});
