import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("Meta page-token cache is tenant-keyed and invalidated when the source token rotates", () => {
  // This used to pin the statements inside getPageToken verbatim, which made it a
  // test that the function had not been edited. Those rules moved onto
  // DerivedCredentialCache, where tests/metaCredentialCache.test.ts exercises them
  // against a real cache with a controlled clock. What is worth pinning HERE is
  // the wiring the cache cannot check for itself: that the page token goes through
  // it at all, keyed by tenant, with the credential passed in.
  const code = src("src/lib/messenger.ts");
  assert.match(code, /new DerivedCredentialCache<string>\(\{ ttlMs: PAGE_TOKEN_TTL_MS \}\)/);
  const fn = code.slice(
    code.indexOf("async function getPageToken"),
    code.indexOf("export async function sendDirectMessage"),
  );
  assert.match(fn, /pageTokenCache\.resolve\(tenantId \?\? GLOBAL_TOKEN_KEY, sysToken,/, "keyed by tenant, credential passed in");
  // A single shared slot cannot express "whose token is this", whatever it is called.
  assert.doesNotMatch(code, /let\s+cachedPageToken\s*:/);
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
