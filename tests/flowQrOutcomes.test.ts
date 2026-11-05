import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { qrOutcomeLine, sentQuoteFamilies } from "../src/lib/flowQr";

test("quotes sent count families: a declined original with a sent revision is one", () => {
  // Review of #1000: the original was excluded by its status and the revision by being a revision → zero.
  const q = (id: string, status: string, revisionOfId: string | null = null) => ({ id, status, revisionOfId });
  assert.equal(sentQuoteFamilies([q("a", "declined"), q("a2", "sent", "a")]), 1);
  assert.equal(sentQuoteFamilies([q("b", "sent"), q("b2", "sent", "b"), q("b3", "accepted", "b2")]), 1, "a chain counts once");
  assert.equal(sentQuoteFamilies([q("c", "draft"), q("c2", "declined", "c")]), 0, "never sent");
  assert.equal(sentQuoteFamilies([q("d2", "sent", "d_deleted")]), 1, "the original was deleted");
  assert.equal(sentQuoteFamilies([q("e", "sent"), q("f", "accepted")]), 2);
});

const rand = (cents: number) => `R ${(cents / 100).toLocaleString("en-ZA")}`;

test("a QR code's line reads customers → quotes → sales, with the value only for those who may see it", () => {
  assert.equal(qrOutcomeLine({ people: 12, quotes: 3, won: 1, wonCents: 2999900 }, rand), `12 new customers → 3 quotes sent → 1 sale (${rand(2999900)})`);
  assert.equal(qrOutcomeLine({ people: 12, quotes: 3, won: 1, wonCents: null }, rand), "12 new customers → 3 quotes sent → 1 sale", "no sales figures for this viewer");
  assert.equal(qrOutcomeLine({ people: 1, quotes: 0, won: 0, wonCents: 0 }, rand), "1 new customer → 0 quotes sent → 0 sales");
});

test("the outcomes are this workspace's, from the QR's own customers, and the value is gated", () => {
  const lib = readFileSync("src/lib/flowQrOutcomes.ts", "utf8");
  assert.match(lib, /contact\.findMany\(\{ where: \{ tenantId, source \}/);
  assert.match(lib, /where: \{ tenantId, deletedAt: null, OR: \[\{ contactId: \{ in: ids \} \}, \{ lead: \{ contactId: \{ in: ids \} \} \}\] \}/);
  assert.match(lib, /quotes: sentQuoteFamilies\(quoteRows\)/);
  assert.match(lib, /tenantId, deletedAt: null, status: "won", contactId: \{ in: ids \}/);
  assert.match(lib, /wonCents: showValue \?/);
  const page = readFileSync("src/app/(app)/bot-builder/routes/page.tsx", "utf8");
  assert.match(page, /const showSalesValue = await hasPermission\(viewer, "forecast\.view"\)/);
  assert.match(page, /qrOutcomes\(tenantId, qrSource\(qr\.name\), showSalesValue\)/);
});
