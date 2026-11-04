import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { qrOutcomeLine } from "../src/lib/flowQr";

const rand = (cents: number) => `R ${(cents / 100).toLocaleString("en-ZA")}`;

test("a QR code's line reads customers → quotes → sales, with the value only for those who may see it", () => {
  assert.equal(qrOutcomeLine({ people: 12, quotes: 3, won: 1, wonCents: 2999900 }, rand), `12 new customers → 3 quotes sent → 1 sale (${rand(2999900)})`);
  assert.equal(qrOutcomeLine({ people: 12, quotes: 3, won: 1, wonCents: null }, rand), "12 new customers → 3 quotes sent → 1 sale", "no sales figures for this viewer");
  assert.equal(qrOutcomeLine({ people: 1, quotes: 0, won: 0, wonCents: 0 }, rand), "1 new customer → 0 quotes sent → 0 sales");
});

test("the outcomes are this workspace's, from the QR's own customers, and the value is gated", () => {
  const lib = readFileSync("src/lib/flowQrOutcomes.ts", "utf8");
  assert.match(lib, /contact\.findMany\(\{ where: \{ tenantId, source \}/);
  assert.match(lib, /tenantId, deletedAt: null, revisionOfId: null, status: \{ in: \["sent", "accepted"\] \}/);
  assert.match(lib, /OR: \[\{ contactId: \{ in: ids \} \}, \{ lead: \{ contactId: \{ in: ids \} \} \}\]/);
  assert.match(lib, /tenantId, deletedAt: null, status: "won", contactId: \{ in: ids \}/);
  assert.match(lib, /wonCents: showValue \?/);
  const page = readFileSync("src/app/(app)/bot-builder/routes/page.tsx", "utf8");
  assert.match(page, /const showSalesValue = await hasPermission\(viewer, "forecast\.view"\)/);
  assert.match(page, /qrOutcomes\(tenantId, qrSource\(qr\.name\), showSalesValue\)/);
});
