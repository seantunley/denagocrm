import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  TENANT_CREDENTIAL_INTEGRATIONS,
  TENANT_CREDENTIAL_KEYS,
  isKnownTenantCredentialKey,
  isBooleanTenantCredentialField,
} from "../src/lib/tenantCredentialFields";
import { isSecretSettingKey } from "../src/lib/settings";

/**
 * Pure-logic coverage for the per-tenant integration-credential-overrides UI
 * (src/app/(app)/settings/integration-overrides/page.tsx +
 * src/app/actions/tenantCredentials.ts). The page/actions themselves need a
 * request/session/DB to exercise end to end, so — matching this repo's
 * existing convention for DB-touching glue code (see
 * tests/tenantIntegrationCredential.test.ts) — this file covers what's
 * extractable without one: the known-key set, the secret-vs-plain
 * classification each field's <input type> depends on, and source-shape
 * invariants for the parts that genuinely need a database.
 */

const EXPECTED_KEYS_BY_INTEGRATION: Record<string, string[]> = {
  whatsapp: ["WA_PHONE_NUMBER_ID", "WA_ACCESS_TOKEN"],
  meta: ["META_PAGE_ACCESS_TOKEN"],
  telegram: ["TELEGRAM_BOT_TOKEN"],
  smtp: ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"],
  imap: ["IMAP_HOST", "IMAP_PORT", "IMAP_SECURE", "IMAP_USER", "IMAP_PASS"],
  sms: ["BULKSMS_TOKEN_ID", "BULKSMS_TOKEN_SECRET"],
  "google-reviews": ["GOOGLE_PLACES_API_KEY", "GOOGLE_PLACE_ID"],
};

test("TENANT_CREDENTIAL_INTEGRATIONS covers exactly the 7 integrations, each with the exact expected key set", () => {
  assert.deepEqual(
    TENANT_CREDENTIAL_INTEGRATIONS.map((integration) => integration.id).sort(),
    Object.keys(EXPECTED_KEYS_BY_INTEGRATION).sort(),
  );
  for (const integration of TENANT_CREDENTIAL_INTEGRATIONS) {
    assert.deepEqual(
      integration.fields.map((field) => field.key),
      EXPECTED_KEYS_BY_INTEGRATION[integration.id],
      `unexpected key set for integration "${integration.id}"`,
    );
  }
});

test("TENANT_CREDENTIAL_KEYS / isKnownTenantCredentialKey recognise every declared field key and reject anything else", () => {
  const allDeclaredKeys = Object.values(EXPECTED_KEYS_BY_INTEGRATION).flat();
  assert.equal(TENANT_CREDENTIAL_KEYS.size, allDeclaredKeys.length);
  for (const key of allDeclaredKeys) {
    assert.equal(isKnownTenantCredentialKey(key), true, `${key} should be a known tenant credential key`);
  }
  // A real secret key that exists in AppSetting's namespace but ISN'T one of
  // the 7 tenant-overridable integrations (e.g. the platform's own AI key)
  // must never be settable as a tenant override.
  assert.equal(isKnownTenantCredentialKey("ANTHROPIC_API_KEY"), false);
  assert.equal(isKnownTenantCredentialKey(""), false);
  assert.equal(isKnownTenantCredentialKey("not-a-real-key"), false);
});

test("secret-vs-plain classification (isSecretSettingKey) matches what each field's <input type> must be", () => {
  const expectedSecret = new Set([
    "WA_ACCESS_TOKEN",
    "META_PAGE_ACCESS_TOKEN",
    "TELEGRAM_BOT_TOKEN",
    "SMTP_PASS",
    "IMAP_PASS",
    "BULKSMS_TOKEN_ID",
    "BULKSMS_TOKEN_SECRET",
    "GOOGLE_PLACES_API_KEY",
  ]);
  for (const integration of TENANT_CREDENTIAL_INTEGRATIONS) {
    for (const field of integration.fields) {
      const expected = expectedSecret.has(field.key);
      assert.equal(
        isSecretSettingKey(field.key),
        expected,
        `${field.key} secret-classification mismatch — a secret key rendered as plain text (or vice-versa) would leak/mis-render it`,
      );
    }
  }
});

test("isBooleanTenantCredentialField only flags SMTP_SECURE/IMAP_SECURE (rendered as a select, not a text/password input)", () => {
  const allKeys = TENANT_CREDENTIAL_INTEGRATIONS.flatMap((integration) => integration.fields.map((f) => f.key));
  for (const key of allKeys) {
    assert.equal(
      isBooleanTenantCredentialField(key),
      key === "SMTP_SECURE" || key === "IMAP_SECURE",
    );
  }
});

// ── Source-shape checks for the parts that genuinely need a database ────────
// (a real request/session + Prisma call), matching this repo's existing
// convention (see tests/tenantIntegrationCredential.test.ts,
// tests/tenantCronSafety.test.ts) for asserting invariants in DB/session
// touching glue code without a live database.

const root = fileURLToPath(new URL("..", import.meta.url));
const settingsSrc = readFileSync(join(root, "src/lib/settings.ts"), "utf8");
const actionsSrc = readFileSync(join(root, "src/app/actions/tenantCredentials.ts"), "utf8");
const pageSrc = readFileSync(
  join(root, "src/app/(app)/settings/integration-overrides/page.tsx"),
  "utf8",
);

test("hasTenantCredentialOverride is an existence-only check — selects only `id`, never the (encrypted) value", () => {
  assert.match(
    settingsSrc,
    /export async function hasTenantCredentialOverride[\s\S]*?findUnique\(\s*\{\s*where:\s*\{\s*tenantId_key:\s*\{\s*tenantId,\s*key\s*\}[\s\S]*?select:\s*\{\s*id:\s*true\s*\}/,
    "hasTenantCredentialOverride must filter by the explicit compound (tenantId, key) and select only `id`",
  );
  assert.match(
    settingsSrc,
    /export async function hasTenantCredentialOverride[\s\S]*?return row !== null;/,
  );
});

test("saveTenantCredentialOverride: owner-gated, validates the key, resolves tenantId from the session (never the form), and never audits the raw value", () => {
  assert.match(actionsSrc, /export async function saveTenantCredentialOverride[\s\S]*?requireOwner\(\)/);
  assert.match(actionsSrc, /isKnownTenantCredentialKey\(key\)/);
  assert.match(actionsSrc, /getActiveTenantId\(\)/);
  assert.match(actionsSrc, /putTenantCredential\(tenantId, key, value\)/);
  // The audit call for this action must carry only the key, never `value`.
  const auditCallMatch = actionsSrc.match(/logAuditStrict\(\{[^}]*tenant_credential\.override_set[\s\S]*?\}\);/);
  assert.ok(auditCallMatch, "expected a logAuditStrict call for tenant_credential.override_set");
  assert.doesNotMatch(auditCallMatch![0], /\bvalue\b/, "the audit entry must never reference the raw submitted value");
});

test("clearTenantCredentialOverride: owner-gated, validates the key, deletes by (tenantId, key) via deleteMany (idempotent, no P2025)", () => {
  assert.match(actionsSrc, /export async function clearTenantCredentialOverride[\s\S]*?requireOwner\(\)/);
  assert.match(actionsSrc, /isKnownTenantCredentialKey\(key\)/);
  assert.match(
    actionsSrc,
    /tenantIntegrationCredential\.deleteMany\(\s*\{\s*where:\s*\{\s*tenantId,\s*key\s*\}\s*\}\s*\)/,
  );
});

test("the overrides page never renders a decrypted value back into the DOM — only hasOverride booleans feed placeholders/labels", () => {
  assert.doesNotMatch(pageSrc, /defaultValue=\{.*(field|hasOverride|override).*value/i);
  assert.match(pageSrc, /hasTenantCredentialOverride/);
});
