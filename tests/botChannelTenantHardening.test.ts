import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("Meta page-token cache is tenant-keyed and invalidated when the source token rotates", () => {
  // Written against identifier names (`tenantKey`, `tokenHash`, `"__global__"`),
  // which made it a test that the function had not been RENAMED. Restated as the
  // properties it was reaching for, so the cache can be improved without the test
  // having to be rewritten each time. tests/metaCredentialCache.test.ts covers the
  // same ground in detail.
  const code = src("src/lib/messenger.ts");
  const fn = code.slice(
    code.indexOf("async function getPageToken"),
    code.indexOf("export async function sendDirectMessage"),
  );
  // Keyed per tenant — a single shared slot cannot express "whose token is this".
  assert.doesNotMatch(code, /let\s+cachedPageToken\s*:/);
  assert.match(code, /pageTokenCache\s*=\s*new Map</);
  assert.match(fn, /pageTokenCache\.get\(cacheKey\)/);
  assert.match(fn, /pageTokenCache\.set\(cacheKey,/);
  // Bound to a fingerprint of the credential read THIS call, so a rotation
  // invalidates the derived token rather than waiting out the TTL.
  assert.match(fn, /cached\.sourceHash === sourceHash/);
});

test("Telegram tenant resolution happens before any guarded webhook work", () => {
  const route = src("src/app/api/webhooks/telegram/route.ts");
  assert.match(route, /withTelegramTenantScope\(/);
  const scopeAt = route.indexOf("withTelegramTenantScope(");
  const claimAt = route.indexOf("claimInboundBotEvent", scopeAt);
  const flowAt = route.indexOf("runTelegramFlow", scopeAt);
  assert.ok(scopeAt >= 0 && claimAt > scopeAt && flowAt > scopeAt);
  assert.doesNotMatch(route, /withSystemScope/);
  assert.doesNotMatch(route, /getSetting\("TELEGRAM_WEBHOOK_SECRET"\)/);
});

test("Telegram resolver considers only active tenants and never returns the webhook secret", () => {
  const code = src("src/lib/telegramTenant.ts");
  assert.match(code, /JOIN "Tenant" t ON t\."id" = s\."tenantId"/);
  assert.match(code, /t\."active" = true/);
  assert.match(code, /s\."key" = 'TELEGRAM_WEBHOOK_SECRET'/);
  assert.match(code, /secretEquals\(secret, expected\)/);
  assert.match(code, /return row\.tenantId/);
  assert.doesNotMatch(code, /console\.|logError/);
});

test("Telegram webhook authentication never disappears when tenancy enforcement is off", () => {
  const code = src("src/lib/telegramTenant.ts");
  assert.match(code, /if \(!secret\) return onUnresolved\(\)/);
  assert.doesNotMatch(code, /if \(!tenantEnforcing\(\)\) return fn\(\)/);
  assert.match(code, /const expected = await getSetting\("TELEGRAM_WEBHOOK_SECRET"\)/);
  assert.match(code, /if \(expected && secretEquals\(secret, expected\)\) return fn\(\)/);
  assert.match(code, /return onUnresolved\(\)/);
});

test("Telegram secrets are decrypted only inside the trusted pre-scope resolver", () => {
  const code = src("src/lib/telegramTenant.ts");
  assert.match(code, /basePrisma\.\$queryRaw/);
  assert.match(code, /expected = decryptValue\(row\.value\)/);
  assert.match(code, /runInTenantScope\(\{ tenantId, system: false \}, fn\)/);
});
