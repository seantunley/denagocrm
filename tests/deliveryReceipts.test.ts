import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  metaReceipt,
  whatsappReceipt,
  receiptFields,
  receiptLabel,
  RECEIPT_CHANNELS,
} from "../src/lib/deliveryReceipts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * Delivered and Seen, under an outbound message.
 *
 * The model is a WATERMARK — "everything up to here has been seen" — because that
 * is literally what Meta sends: a read event carries one timestamp and no message
 * ids at all. The two platforms also disagree about what a timestamp IS, which is
 * the kind of detail that silently sets every receipt to 1970 or to the year
 * 56000 if nobody checks it.
 */

test("Meta's watermark is milliseconds; WhatsApp's is seconds", () => {
  // The same instant, expressed the two different ways each platform sends it.
  const ms = 1786183167447;
  const meta = metaReceipt({ sender: { id: "psid_1" }, read: { watermark: ms } }, "messenger");
  assert.ok(meta);
  assert.equal(meta.at.getTime(), ms);

  const wa = whatsappReceipt({ status: "read", recipient_id: "27821234567", timestamp: String(Math.floor(ms / 1000)) });
  assert.ok(wa);
  // Treating WhatsApp's seconds as milliseconds would land in January 1970.
  assert.equal(wa.at.getUTCFullYear(), new Date(ms).getUTCFullYear());
});

test("a read event outranks a delivery event on the same payload", () => {
  const both = metaReceipt(
    { sender: { id: "psid_1" }, delivery: { watermark: 1000 }, read: { watermark: 2000 } },
    "messenger",
  );
  assert.equal(both?.level, "seen");
});

test("a delivery event is 'delivered'", () => {
  const r = metaReceipt({ sender: { id: "psid_1" }, delivery: { watermark: 1000 } }, "instagram");
  assert.equal(r?.level, "delivered");
  assert.equal(r?.channel, "instagram");
});

test("a malformed watermark is refused, not defaulted", () => {
  // A watermark of 0 marks nothing; a watermark of "now" would mark the ENTIRE
  // conversation seen. Both are worse than dropping the event.
  for (const bad of [undefined, null, 0, -1, "banana", NaN]) {
    assert.equal(metaReceipt({ sender: { id: "p" }, read: { watermark: bad } }, "messenger"), null, String(bad));
  }
  assert.equal(metaReceipt({ read: { watermark: 1000 } }, "messenger"), null, "no sender id");
});

test("WhatsApp 'sent' and 'failed' are not receipts", () => {
  // `sent` is not news — we already know, that is why a row exists. `failed` is
  // not a quieter kind of success and must not be recorded as one.
  for (const s of ["sent", "failed", "deleted", undefined]) {
    assert.equal(whatsappReceipt({ status: s, recipient_id: "27821234567", timestamp: "1786183167" }), null, String(s));
  }
});

test("a phone number is matched on digits, however it was formatted", () => {
  const r = whatsappReceipt({ status: "delivered", recipient_id: "+27 82 123 4567", timestamp: "1786183167" });
  assert.equal(r?.recipientRef, "27821234567");
});

test("seen implies delivered", () => {
  // A phone that was offline when the message arrived can produce a read event
  // with no preceding delivery. "Seen" above an empty "Delivered" looks broken.
  const at = new Date("2026-08-08T13:00:00Z");
  assert.deepEqual(receiptFields("seen", at), { deliveredAt: at, seenAt: at });
  assert.deepEqual(receiptFields("delivered", at), { deliveredAt: at });
});

test("the label describes OUR message, never theirs", () => {
  const seen = { direction: "outbound", deliveredAt: new Date(), seenAt: new Date() };
  assert.equal(receiptLabel(seen, true), "Seen");
  assert.equal(receiptLabel({ direction: "outbound", deliveredAt: new Date() }, true), "Delivered");
  assert.equal(receiptLabel({ direction: "outbound" }, true), "Sent");
  // Inbound gets nothing: labelling the customer's own message "Sent" is noise.
  assert.equal(receiptLabel({ direction: "inbound", seenAt: new Date() }, true), null);
});

test("a channel that reports nothing shows nothing", () => {
  // "Sent" forever would imply we are waiting on a receipt that will never come.
  assert.equal(receiptLabel({ direction: "outbound" }, false), null);
  assert.ok(RECEIPT_CHANNELS.has("whatsapp") && RECEIPT_CHANNELS.has("messenger"));
  assert.ok(!RECEIPT_CHANNELS.has("email"));
});

test("the update never walks a receipt backwards", () => {
  // Receipts arrive repeatedly and out of order. Without the null guards a later
  // `delivered` for an older watermark would overwrite a `seen`, and the bubble
  // would go from Seen back to Delivered.
  const code = src("src/lib/messageReceipts.ts");
  assert.match(code, /deliveredAt: null,/, "only stamp rows that have no delivery yet");
  assert.match(code, /seenAt: null,/, "and no seen yet");
  assert.match(code, /direction: "outbound"/, "a receipt is about OUR message");
  assert.match(code, /occurredAt: \{ lte: receipt\.at \}/, "the watermark's whole meaning");
});

test("both webhooks hand their events to the same rule", () => {
  const meta = src("src/app/api/webhooks/meta/route.ts");
  assert.match(meta, /if \(ev\.delivery \|\| ev\.read\)/);
  assert.match(meta, /metaReceipt\(ev, platform\)/);
  // Handled BEFORE the message branches: a receipt carries no text and would
  // otherwise fall through them as an empty message.
  assert.ok(meta.indexOf("metaReceipt(") < meta.indexOf("ev.message?.is_echo"));

  const wa = src("src/app/api/webhooks/whatsapp/route.ts");
  assert.match(wa, /for \(const status of value\.statuses \?\? \[\]\)/);
  assert.match(wa, /whatsappReceipt\(status\)/);
});

/**
 * …AND IT MUST NOT REACH ANOTHER TENANT'S MESSAGES.
 *
 * The first version ran every query on basePrisma — the client that sets
 * app.bypass_rls='on' — and justified the missing tenant filter on the grounds
 * that the webhook had already entered withChannelTenantScope. That is backwards:
 * a tenant scope constrains the SCOPED client; basePrisma is the one that ignores
 * it, which is why it exists.
 *
 * WhatsApp made it exploitable rather than theoretical. messengerPsid and
 * instagramId are unique columns, but a PHONE NUMBER is not — the same number can
 * legitimately belong to two tenants' customers. A receipt for tenant A could
 * resolve tenant B's contact through LIMIT 1 and then stamp tenant B's rows.
 */

test("every query in the receipt path names its tenant", () => {
  const code = src("src/lib/messageReceipts.ts");
  assert.match(code, /activeTenantPredicate\(/, "the repo's own helper, which fails closed");
  // Resolved ONCE and threaded, so no branch can forget it.
  assert.equal(
    (code.match(/\.\.\.tenant,/g) ?? []).length,
    3,
    "both updateMany calls and the psid/ig lookup must spread the predicate",
  );
  assert.match(code, /contactForRecipient\(receipt, tenant\)/, "the lookup takes it explicitly");
});

test("the phone lookup — the one with no unique index — carries a tenant clause", () => {
  const code = src("src/lib/messageReceipts.ts");
  const lookup = code.slice(code.indexOf("async function contactForRecipient"));
  assert.match(lookup, /IS NOT DISTINCT FROM \$\{tenant\.tenantId\}/,
    "and uses IS NOT DISTINCT FROM, because tenantId is still NULL everywhere");
  assert.doesNotMatch(lookup, /"tenantId" = \$\{/, "`= NULL` matches nothing");
  assert.match(lookup, /ORDER BY "id"/, "deterministic within a tenant");
});

test("no query in this file is left unscoped", () => {
  // A structural sweep rather than three named assertions: the failure mode is a
  // FOURTH query added later without the predicate.
  const code = src("src/lib/messageReceipts.ts");
  const queries = code.match(/basePrisma\.\w+\.(updateMany|findFirst|findUnique)\(\{[\s\S]*?\}\)/g) ?? [];
  assert.ok(queries.length >= 3, `expected the receipt queries, found ${queries.length}`);
  for (const q of queries) {
    assert.match(q, /\.\.\.tenant,/, `an unscoped query on basePrisma:\n${q.slice(0, 200)}`);
  }
});
