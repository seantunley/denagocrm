import crypto from "crypto";
import { prisma, basePrisma } from "./db";

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
  const row = await prisma.appSetting.findUnique({ where: { key } });
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
  await prisma.appSetting.upsert({
    where: { key },
    update: { value: stored },
    create: { key, value: stored },
  });
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
 * IMAP, SMS, Google Reviews), preferring a TENANT-specific override over the
 * install-global `AppSetting` row for the same `key`.
 *
 * `tenantId` is supplied EXPLICITLY by the caller (never read from ambient
 * scope in here) — resolve it however that call site already does (a cron
 * slice's tenant, `currentTenantScope()?.tenantId`, a resolved channel scope,
 * etc.) and pass it in, or pass `null` where no tenant is known.
 *
 * THE CRITICAL INVARIANT: with zero `TenantIntegrationCredential` rows (true
 * today — nothing writes this table yet), every call falls through to
 * `getGlobal(key)` regardless of `tenantId` — byte-for-byte today's
 * `getSetting(key)` result. A tenant only ever gets a different answer once it
 * has saved its OWN override row for that exact key.
 *
 * `lookupOverride`/`getGlobal` are overridable purely so the fallback logic is
 * unit-testable without a database (see tests/tenantIntegrationCredential.test.ts);
 * every real call site relies on the defaults.
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
