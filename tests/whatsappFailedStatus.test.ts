import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { whatsappFailure, whatsappSendResult, whatsappTransportFailure } from "../src/lib/deliveryReceipts";
import { classifyDeliveryFailure, deliveryLabel } from "../src/lib/messageDelivery";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("the wamid is captured from a successful send", () => {
  const ok = whatsappSendResult({ ok: true, status: 200 }, {
    messaging_product: "whatsapp",
    contacts: [{ input: "27821234567", wa_id: "27821234567" }],
    messages: [{ id: "wamid.HBgLMjc4MjEyMzQ1NjcVAgARGBI" }],
  });
  assert.deepEqual(ok, { ok: true, providerMessageId: "wamid.HBgLMjc4MjEyMzQ1NjcVAgARGBI" });
  assert.deepEqual(whatsappSendResult({ ok: true, status: 200 }, null), { ok: true }, "no body is still a send");
  assert.deepEqual(whatsappSendResult({ ok: false, status: 400 }, { error: { message: "bad" } }), { ok: false, error: "bad" });
});

test("a timeout is a failed send the outbox retries, not a throw", () => {
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const r = whatsappTransportFailure(timeout);
  assert.equal(r.ok, false);
  assert.equal(classifyDeliveryFailure(r.error!), "transient_network");
  assert.equal(classifyDeliveryFailure(whatsappTransportFailure(new TypeError("fetch failed")).error!), "transient_network");
  // Every /messages send goes through the wrapped helper.
  const wa = src("src/lib/whatsapp.ts");
  assert.equal(wa.match(/\/messages`/g)?.length, 1, "one fetch to /messages, inside postWhatsAppMessage");
  assert.match(wa, /catch \(error\) \{\s*return whatsappTransportFailure\(error\);/);
});

test("a `failed` status is parsed with Meta's code, keyed by wamid", () => {
  // The whole status entry as Meta sends it.
  const status = {
    id: "wamid.ABC",
    status: "failed",
    timestamp: "1786183167",
    recipient_id: "27821234567",
    errors: [{ code: 131047, title: "Re-engagement message", error_data: { details: "more than 24 hours…" } }],
  };
  const f = whatsappFailure(status);
  assert.deepEqual(f, { providerMessageId: "wamid.ABC", failureCode: "outside_window", detail: "131047 Re-engagement message" });
  assert.equal(whatsappFailure({ id: "wamid.X", status: "failed", errors: [{ code: 999, title: "Odd" }] })?.failureCode, "provider_error");
  assert.equal(whatsappFailure({ id: "wamid.X", status: "delivered" }), null);
  assert.equal(whatsappFailure({ status: "failed" }), null, "no wamid → nothing to match");
});

test("a failed message reads 'Not delivered' even after a later receipt watermark stamps it", () => {
  // The watermark stamps deliveredAt on EVERY earlier outbound row, so the
  // failed one would otherwise read Delivered ✓✓.
  const stamped = { direction: "outbound", deliveredAt: new Date(), seenAt: new Date() };
  assert.deepEqual(deliveryLabel(stamped, true, { status: "dead", failureCode: "outside_window" }), {
    text: "Not delivered — outside the 24-hour reply window",
    tone: "failed",
  });
  assert.equal(deliveryLabel(stamped, true, { status: "sent" })?.text, "Seen ✓✓");
});

test("the webhook applies `failed` to the outbox row with that wamid", () => {
  const route = src("src/app/api/webhooks/whatsapp/route.ts");
  assert.match(route, /const failure = whatsappFailure\(status\);\s*if \(failure\) await applyProviderFailure\("whatsapp", failure\);/);
  const outbox = src("src/lib/botOutbox.ts");
  const ledger = outbox.slice(outbox.indexOf("function failureLedger"), outbox.indexOf("export async function applyProviderFailure"));
  assert.match(ledger, /const tenantId = outboxTenantId\(\)/);
  assert.match(ledger, /where: \{ tenantId, channel, providerMessageId: failure\.providerMessageId/);
  assert.match(ledger, /status: "dead", failureCode: failure\.failureCode/);
  // The early-arrival race is covered in whatsappFailureRace.test.ts.
  // …and the wamid reaches the Communication.
  assert.match(outbox, /data: \{ messageId: providerMessageId \}/);
});
