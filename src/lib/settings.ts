import crypto from "crypto";
import { prisma, basePrisma } from "./db";
import { DEFAULT_TENANT_ID } from "./tenant";
import { TENANT_CREDENTIAL_INTEGRATIONS } from "./tenantCredentialFields";
import { tenantEnforcing } from "./tenantEnforcement";
import { currentTenantScope } from "./tenantScope";

/**
 * Settings that hold credentials are encrypted at rest with AES-256-GCM
 * (SETTINGS_ENCRYPTION_KEY env var, 64 hex chars = 32 bytes). A leaked
 * database dump or backup then exposes ciphertext, not tokens. Values are
 * stored as "enc:v1:<iv>:<tag>:<ciphertext>" and decrypted transparently.
 */
const SECRET_KEYS = new Set([
  "SMTP_PASS",
  "IMAP_PASS",
  "META_PAGE_ACCESS_TOKEN",
  "META_APP_SECRET",
  "META_VERIFY_TOKEN",
  "WA_ACCESS_TOKEN",
  "BULKSMS_TOKEN_ID",
  "BULKSMS_TOKEN_SECRET",
  "GOOGLE_PLACES_API_KEY",
  "GOOGLE_MAPS_BROWSER_API_KEY",
  "ANTHROPIC_API_KEY",
  "INTAKE_API_KEY",
  "OPENAI_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
]);

const PREFIX = "enc:v1:";
const BINARY_MAGIC = Buffer.from("DCRMBAK2");

function encryptionKey(): Buffer | null {
  const hex = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) return null;
  try {
    return Buffer.from(hex, "hex");
  } catch {
    return null;
  }
}

function requireEncryptionKey(): Buffer {
  const key = encryptionKey();
  if (!key) throw new Error("SETTINGS_ENCRYPTION_KEY missing/invalid");
  return key;
}

export function encryptValue(plain: string): string {
  const key = encryptionKey();
  if (!key) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SETTINGS_ENCRYPTION_KEY missing/invalid — refusing to store a credential in clear text");
    }
    return plain;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
}

export function decryptValue(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const key = requireEncryptionKey();
  const [iv, tag, data] = stored.slice(PREFIX.length).split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Binary AES-256-GCM envelope used for uploaded-file snapshots. */
export function encryptBytes(plain: Buffer): Buffer {
  const key = requireEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([BINARY_MAGIC, iv, cipher.getAuthTag(), encrypted]);
}

export function decryptBytes(stored: Buffer): Buffer {
  if (!stored.subarray(0, BINARY_MAGIC.length).equals(BINARY_MAGIC)) {
    throw new Error("Unsupported binary backup envelope");
  }
  const key = requireEncryptionKey();
  const offset = BINARY_MAGIC.length;
  const iv = stored.subarray(offset, offset + 12);
  const tag = stored.subarray(offset + 12, offset + 28);
  const encrypted = stored.subarray(offset + 28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

export function isSecretSettingKey(key: string): boolean {
  return SECRET_KEYS.has(key);
}

export async function getSetting(key: string): Promise<string | null> {
  // findFirst: guard adds tenantId to where under enforcement (tenant scope),
  // passes through in system scope / off-mode (finds any row with this key).
  const row = await prisma.appSetting.findFirst({ where: { key } });
  if (!row?.value) return null;
  try {
    return decryptValue(row.value);
  } catch {
    return null;
  }
}

/** Writes a setting, encrypting credential-class keys when a key is configured. */
export async function putSetting(key: string, value: string): Promise<void> {
  const stored = value && isSecretSettingKey(key) ? encryptValue(value) : value;
  const scope = tenantEnforcing() ? currentTenantScope() : null;
  if (scope && !scope.system && scope.tenantId) {
    // Tenant-scoped write: must address the compound unique key explicitly
    // (guard.scopeWhere only injects tenantId at top level, not into the
    // compound accessor that Prisma needs for upsert's WHERE lookup).
    await prisma.appSetting.upsert({
      where: { tenantId_key: { tenantId: scope.tenantId, key } },
      update: { value: stored },
      create: { key, value: stored },
    });
    return;
  }
  // Off-enforcement / system scope: locate existing row by key regardless of
  // tenant (preserves the row's current tenantId on update; creates with NULL
  // tenantId when no row exists).
  const existing = await basePrisma.appSetting.findFirst({ where: { key } });
  if (existing) {
    await basePrisma.appSetting.update({ where: { id: existing.id }, data: { value: stored } });
  } else {
    await basePrisma.appSetting.create({ data: { key, value: stored } });
  }
}

/**
 * Raw per-tenant override lookup (`TenantIntegrationCredential`), decrypted with
 * the SAME helper `getSetting`/`putSetting` use for the global `AppSetting` row.
 * Explicit `(tenantId, key)` filter via `basePrisma` — never ambient scope —
 * because callers of {@link resolveTenantCredential} include cron/webhook
 * contexts that may have no request-scoped ALS tenant at all.
 */
async function getTenantCredentialOverride(tenantId: string, key: string): Promise<string | null> {
  const row = await basePrisma.tenantIntegrationCredential.findUnique({
    where: { tenantId_key: { tenantId, key } },
  });
  if (!row?.value) return null;
  try {
    return decryptValue(row.value);
  } catch {
    return null;
  }
}

/**
 * Resolves an outbound-integration credential (WhatsApp, Meta, Telegram, SMTP,
 * IMAP, SMS, Google Reviews) for a tenant.
 *
 * Resolution rules:
 *  - If the tenant has its OWN override row → return it (all tenants).
 *  - If the tenant has NO override AND is the FOUNDING tenant → fall back to
 *    the global AppSetting row (the founding tenant IS the platform; its
 *    platform credentials are its own).
 *  - If the tenant has NO override AND is a SECOND tenant → return null.
 *    Second tenants must configure their own credentials; they never silently
 *    ride the platform owner's accounts, API tokens or sending limits.
 *  - If tenantId is null (no tenant resolved) → fall back to global (pre-
 *    enforcement / system-context callers, unchanged behaviour).
 *
 * `tenantId` is supplied EXPLICITLY by the caller — never read from ambient
 * scope in here — so cron/webhook contexts work correctly.
 *
 * `lookupOverride`/`getGlobal` are injectable for unit tests only
 * (see tests/tenantIntegrationCredential.test.ts); all real callers use defaults.
 */
export async function resolveTenantCredential(
  tenantId: string | null,
  key: string,
  deps: {
    lookupOverride?: (tenantId: string, key: string) => Promise<string | null>;
    getGlobal?: (key: string) => Promise<string | null>;
  } = {},
): Promise<string | null> {
  const lookupOverride = deps.lookupOverride ?? getTenantCredentialOverride;
  const getGlobal = deps.getGlobal ?? getSetting;
  if (tenantId) {
    const override = await lookupOverride(tenantId, key);
    if (override !== null) return override;
    // Second tenants: no fallback to platform credentials.
    if (tenantId !== DEFAULT_TENANT_ID) return null;
  }
  return getGlobal(key);
}

/**
 * Write-side counterpart for a future settings UI: upserts a tenant's OWN
 * override credential for `key`, encrypting credential-class keys exactly like
 * `putSetting` does for the global row. Never touches the global `AppSetting`
 * row — a tenant override lives entirely in `TenantIntegrationCredential`.
 */
export async function putTenantCredential(tenantId: string, key: string, value: string): Promise<void> {
  const stored = value && isSecretSettingKey(key) ? encryptValue(value) : value;
  await basePrisma.tenantIntegrationCredential.upsert({
    where: { tenantId_key: { tenantId, key } },
    update: { value: stored },
    create: { tenantId, key, value: stored },
  });
}

/**
 * Existence-only check for a tenant's own override — powers the tenant-facing
 * "Override active" / "Using platform default" status in the per-tenant
 * credential overrides UI. Deliberately never touches or returns the stored
 * (encrypted) value, let alone a decrypted one — callers only ever learn
 * whether a row exists, same explicit `(tenantId, key)` filter via `basePrisma`
 * as {@link putTenantCredential}/the internal override lookup.
 */
export async function hasTenantCredentialOverride(tenantId: string, key: string): Promise<boolean> {
  const row = await basePrisma.tenantIntegrationCredential.findUnique({
    where: { tenantId_key: { tenantId, key } },
    select: { id: true },
  });
  return row !== null;
}

async function getTenantCredentialOverrides(tenantId: string, keys: readonly string[]): Promise<Map<string, string>> {
  const rows = await basePrisma.tenantIntegrationCredential.findMany({
    where: { tenantId, key: { in: [...keys] } },
    select: { key: true, value: true },
  });
  const result = new Map<string, string>();
  for (const row of rows) {
    if (!row.value) continue;
    try { result.set(row.key, decryptValue(row.value)); } catch { /* skip corrupted rows */ }
  }
  return result;
}

/**
 * Bundle-level resolver: returns the complete key→value map for an integration
 * or null when the integration is unavailable.
 *
 * - Non-founding tenant, all required fields overridden → use tenant values.
 * - Non-founding tenant, incomplete/no overrides → null (unavailable).
 * - Founding tenant or no tenant, bundle active → use tenant overrides;
 *   optional un-overridden fields fall back to global AppSetting.
 * - Founding tenant or no tenant, incomplete/no overrides → use ALL global
 *   settings (never mix one override with platform values for another key).
 */
export async function resolveIntegrationBundle(
  tenantId: string | null,
  integrationId: string,
): Promise<Record<string, string | null> | null> {
  const integration = TENANT_CREDENTIAL_INTEGRATIONS.find((i) => i.id === integrationId);
  if (!integration) return null;

  const keys = integration.fields.map((f) => f.key);
  const requiredKeys = integration.fields.filter((f) => f.required !== false).map((f) => f.key);
  const isFoundingOrNoTenant = !tenantId || tenantId === DEFAULT_TENANT_ID;

  const overrides = tenantId
    ? await getTenantCredentialOverrides(tenantId, keys)
    : new Map<string, string>();

  const allRequiredOverridden = requiredKeys.every((k) => overrides.has(k));

  if (!allRequiredOverridden) {
    if (!isFoundingOrNoTenant) return null;
    const globalValues = await Promise.all(keys.map((k) => getSetting(k)));
    return Object.fromEntries(keys.map((k, i) => [k, globalValues[i]]));
  }

  if (isFoundingOrNoTenant) {
    const unset = keys.filter((k) => !overrides.has(k));
    const fallbacks = await Promise.all(unset.map((k) => getSetting(k)));
    const result: Record<string, string | null> = Object.fromEntries(keys.map((k) => [k, overrides.get(k) ?? null]));
    unset.forEach((k, i) => { result[k] = fallbacks[i]; });
    return result;
  }

  return Object.fromEntries(keys.map((k) => [k, overrides.get(k) ?? null]));
}
