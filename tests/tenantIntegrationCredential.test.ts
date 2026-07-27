import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { resolveTenantCredential } from "../src/lib/settings";

/**
 * `resolveTenantCredential` is the single chokepoint that lets a tenant
 * override an outbound-integration credential (WhatsApp, Meta, Telegram, SMTP,
 * IMAP, SMS, Google Reviews) that today lives only in the GLOBAL `AppSetting`
 * table. The critical invariant: with zero `TenantIntegrationCredential` rows
 * (true today), every call must behave byte-for-byte like the old
 * `getSetting(key)` — regardless of whether a tenantId is known.
 *
 * These tests exercise the real decision logic with injected `lookupOverride`/
 * `getGlobal` stubs (no database, no Prisma call) — the same injectable-dependency
 * pattern already used for the cron fan-out's `now` clock (src/lib/tenantCron.ts).
 */

test("resolveTenantCredential: null tenantId never touches the override lookup, falls straight to global", async () => {
  let lookupCalls = 0;
  const result = await resolveTenantCredential(null, "WA_ACCESS_TOKEN", {
    lookupOverride: async () => {
      lookupCalls++;
      return "should-never-be-returned";
    },
    getGlobal: async (key) => (key === "WA_ACCESS_TOKEN" ? "global-token" : null),
  });
  assert.equal(lookupCalls, 0, "a null tenantId must never query the override table");
  assert.equal(result, "global-token");
});

test("resolveTenantCredential: the FOUNDING tenant with NO override row falls back to the global value", async () => {
  const result = await resolveTenantCredential("tenant_denago_cpt", "SMTP_HOST", {
    lookupOverride: async () => null,
    getGlobal: async (key) => (key === "SMTP_HOST" ? "smtp.example.com" : null),
  });
  assert.equal(result, "smtp.example.com", "founding tenant: no override row → falls back to the platform default");
});

test("resolveTenantCredential: a NON-FOUNDING tenant with NO override row returns null (no platform credential leakage)", async () => {
  let globalCalls = 0;
  const result = await resolveTenantCredential("tenant_A", "SMTP_HOST", {
    lookupOverride: async () => null,
    getGlobal: async () => { globalCalls++; return "smtp.example.com"; },
  });
  assert.equal(result, null, "second tenants must configure their own credentials -- never inherit the platform's");
  assert.equal(globalCalls, 0, "global fallback must never be queried for non-founding tenants");
});

test("resolveTenantCredential: a tenantId WITH a saved override wins over the global value", async () => {
  let globalCalls = 0;
  const result = await resolveTenantCredential("tenant_A", "BULKSMS_TOKEN_ID", {
    lookupOverride: async (tenantId, key) =>
      tenantId === "tenant_A" && key === "BULKSMS_TOKEN_ID" ? "tenant-a-token" : null,
    getGlobal: async () => {
      globalCalls++;
      return "global-token";
    },
  });
  assert.equal(result, "tenant-a-token");
  assert.equal(globalCalls, 0, "an existing override must short-circuit the global fallback");
});

test("resolveTenantCredential: global fallback returning null propagates null (unconfigured stays unconfigured)", async () => {
  const result = await resolveTenantCredential(null, "GOOGLE_PLACES_API_KEY", {
    getGlobal: async () => null,
  });
  assert.equal(result, null);
});

test("resolveTenantCredential: passes the exact (tenantId, key) pair through to the override lookup", async () => {
  const seen: { tenantId: string; key: string }[] = [];
  await resolveTenantCredential("tenant_B", "TELEGRAM_BOT_TOKEN", {
    lookupOverride: async (tenantId, key) => {
      seen.push({ tenantId, key });
      return null;
    },
    getGlobal: async () => null,
  });
  assert.deepEqual(seen, [{ tenantId: "tenant_B", key: "TELEGRAM_BOT_TOKEN" }]);
});

// ── Source-shape checks for the parts that genuinely need a database ────────
// (the real TenantIntegrationCredential lookup + decrypt) and so aren't
// exercised above — matching this repo's existing convention for asserting
// invariants in DB-touching glue code without a live database (see
// tests/tenantCronSafety.test.ts, tests/tenantSchemaContract.test.ts).

const root = fileURLToPath(new URL("..", import.meta.url));
const settingsSrc = readFileSync(join(root, "src/lib/settings.ts"), "utf8");

test("resolveTenantCredential's default override lookup uses an EXPLICIT (tenantId, key) filter via basePrisma, not ambient scope", () => {
  assert.match(
    settingsSrc,
    /basePrisma\.tenantIntegrationCredential\.findUnique\(\s*\{\s*where:\s*\{\s*tenantId_key:\s*\{\s*tenantId,\s*key\s*\}/,
    "the override lookup must filter by an explicit compound (tenantId, key), never an ambient/guarded query",
  );
});

test("resolveTenantCredential decrypts an override with the same helper AppSetting uses, and never throws on bad ciphertext", () => {
  assert.match(settingsSrc, /decryptValue\(row\.value\)/);
  assert.match(
    settingsSrc,
    /getTenantCredentialOverride[\s\S]*?try\s*\{[\s\S]*?decryptValue[\s\S]*?\}\s*catch\s*\{\s*return null;\s*\}/,
    "a decrypt failure on the override row must fall back to null (→ the global setting), never throw",
  );
});

test("putTenantCredential upserts by the same explicit compound key and encrypts credential-class keys like putSetting does", () => {
  assert.match(
    settingsSrc,
    /basePrisma\.tenantIntegrationCredential\.upsert\(\s*\{\s*where:\s*\{\s*tenantId_key:\s*\{\s*tenantId,\s*key\s*\}/,
  );
  assert.match(
    settingsSrc,
    /putTenantCredential[\s\S]*?isSecretSettingKey\(key\)\s*\?\s*encryptValue\(value\)/,
  );
});
