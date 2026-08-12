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

test("every fulfilment action resolves the acting tenant before touching a quote", () => {
  for (const [name, next] of [
    ["markInvoiced", "markDepositPaid"],
    ["markDepositPaid", "scheduleDelivery"],
    ["scheduleDelivery", "uploadDeliveryPhotos"],
    ["uploadDeliveryPhotos", "markDelivered"],
    ["markDelivered", undefined],
  ] as const) {
    const fn = slice(name, next);
    assert.match(fn, /const tenantId = await actingTenantId\(\);/, `${name} must resolve the actor's workspace`);
    assert.match(fn, /quote\.findFirst\(\{[\s\S]*?where: \{ id: quoteId, tenantId \}/, `${name} must re-read the quote inside that workspace`);
  }
});

test("every fulfilment quote mutation carries the tenant on the destructive statement", () => {
  for (const [name, next] of [
    ["markInvoiced", "markDepositPaid"],
    ["markDepositPaid", "scheduleDelivery"],
    ["scheduleDelivery", "uploadDeliveryPhotos"],
    ["markDelivered", undefined],
  ] as const) {
    const fn = slice(name, next);
    assert.match(fn, /quote\.updateMany\(\{\s*where: \{ id: quoteId, tenantId \}/, `${name} must tenant-bind its quote update`);
    assert.match(fn, /if \(updated\.count !== 1\) refuse\(QUOTE_GONE\);/, `${name} must refuse a zero-row tenant-bound update`);
  }
});

test("fulfilment documents inherit the quote owner as database ownership and blob ownership", () => {
  const helperStart = source.indexOf("async function attachStageDocument");
  const helperEnd = source.indexOf("function pickFile", helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /saveFile\([\s\S]*?, tenantId\)/);
  assert.match(helper, /prisma\.document\.create\(\{[\s\S]*?data: \{\s*tenantId,/);

  const delivered = slice("markDelivered");
  assert.match(delivered, /saveFile\([\s\S]*?, quote\.tenantId\)/);
  assert.match(delivered, /document\.create\(\{[\s\S]*?data: \{\s*tenantId: quote\.tenantId,/);
});

test("the old bare-id fulfilment quote updates cannot return", () => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /quote\.update\(\{\s*where: \{ id: quoteId \}/);
  assert.doesNotMatch(code, /quote\.findUniqueOrThrow\(\{\s*where: \{ id: quoteId \}/);
});
