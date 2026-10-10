import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "src/app/actions/fulfilment.ts"), "utf8").replace(/\r\n/g, "\n");

function slice(name: string, next?: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `${name} must exist`);
  const end = next ? source.indexOf(`export async function ${next}`, start) : source.length;
  assert.ok(end > start, `${name} must have a body`);
  return source.slice(start, end);
}

const delivery = readFileSync(path.join(root, "src/lib/quoteDelivery.ts"), "utf8").replace(/\r\n/g, "\n");

test("every fulfilment action resolves the acting tenant before touching a quote", () => {
  for (const [name, next] of [
    ["markInvoiced", "markDepositPaid"],
    ["markDepositPaid", "correctDepositAmount"],
    ["correctDepositAmount", "replaceInvoice"],
    ["scheduleDelivery", "rescheduleDelivery"],
    ["rescheduleDelivery", "registerDeliveryPhotos"],
    ["uploadDeliveryPhotos", "markDelivered"],
  ] as const) {
    const fn = slice(name, next);
    assert.match(fn, /const tenantId = await actingTenantId\(\);/, `${name} must resolve the actor's workspace`);
    assert.match(fn, /quote\.findFirst\(\{[\s\S]*?where: \{ id: quoteId, tenantId \}/, `${name} must re-read the quote inside that workspace`);
  }
  // The invoice / proof-of-payment replacement shares one private helper.
  const replace = source.slice(source.indexOf("async function replaceStageDocument"), source.indexOf("export async function replaceInvoice"));
  assert.match(replace, /const tenantId = await actingTenantId\(\);/);
  assert.match(replace, /quote\.findFirst\(\{ where: \{ id: quoteId, tenantId \} \}\)/);
  // markDelivered resolves the workspace and hands it to the shared delivery,
  // which re-reads the quote inside it.
  assert.match(slice("markDelivered"), /const tenantId = await actingTenantId\(\);[\s\S]*deliverQuote\(\{[\s\S]*tenantId,/);
  assert.match(delivery, /quote\.findFirst\(\{\s*where: \{ id: quoteId, tenantId \}/);
});

test("every fulfilment quote mutation carries the tenant on the destructive statement", () => {
  for (const [name, next] of [
    ["markInvoiced", "markDepositPaid"],
    ["markDepositPaid", "correctDepositAmount"],
    ["correctDepositAmount", "replaceInvoice"],
    ["scheduleDelivery", "rescheduleDelivery"],
  ] as const) {
    const fn = slice(name, next);
    assert.match(fn, /quote\.updateMany\(\{\s*where: \{ id: quoteId, tenantId \}/, `${name} must tenant-bind its quote update`);
    assert.match(fn, /if \(updated\.count !== 1\) refuse\(QUOTE_GONE\);/, `${name} must refuse a zero-row tenant-bound update`);
  }
  assert.match(slice("rescheduleDelivery", "registerDeliveryPhotos"), /quote\.updateMany\(\{\s*where: \{ id: quoteId, tenantId, deliveredAt: null/);
  // `deletedAt: null` is written out because the delivery's transaction is
  // basePrisma's — a real one, where no scoped client adds it (oneDeliveryFlow.test.ts).
  assert.match(delivery, /tx\.quote\.updateMany\(\{\s*where: \{ id: quoteId, tenantId, deliveredAt: null, deletedAt: null \}/, "the delivery must tenant-bind its quote update");
  assert.match(delivery, /if \(updated\.count !== 1\) refuse\(/, "and refuse a zero-row update");
});

test("fulfilment documents inherit the quote owner as database ownership and blob ownership", () => {
  const helperStart = source.indexOf("async function attachStageDocument");
  const helperEnd = source.indexOf("function pickFile", helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /saveFile\([\s\S]*?, tenantId\)/);
  assert.match(helper, /prisma\.document\.create\(\{[\s\S]*?data: \{\s*tenantId,/);

  // Delivery paperwork is staged by markDelivered and filed by deliverQuote,
  // which uploads under the quote's owner and creates the rows in its transaction.
  assert.match(delivery, /save: \(buffer, originalName, mimeType\) => saveFile\(buffer, originalName, mimeType, quote\.tenantId\)/);
  assert.match(delivery, /tx\.document\.create\(\{\s*data: \{\s*tenantId: quote\.tenantId,/);
});

test("the old bare-id fulfilment quote updates cannot return", () => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /quote\.update\(\{\s*where: \{ id: quoteId \}/);
  assert.doesNotMatch(code, /quote\.findUniqueOrThrow\(\{\s*where: \{ id: quoteId \}/);
});
