import crypto from "crypto";
import { prisma } from "./db";

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
  "ANTHROPIC_API_KEY",
  "INTAKE_API_KEY",
]);

const PREFIX = "enc:v1:";

function encryptionKey(): Buffer | null {
  const hex = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) return null;
  try {
    return Buffer.from(hex, "hex");
  } catch {
    return null;
  }
}

export function encryptValue(plain: string): string {
  const key = encryptionKey();
  if (!key) return plain; // key not configured yet — store as-is rather than break
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
}

export function decryptValue(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const key = encryptionKey();
  if (!key) {
    throw new Error("SETTINGS_ENCRYPTION_KEY missing but an encrypted setting exists");
  }
  const [iv, tag, data] = stored.slice(PREFIX.length).split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64")),
    decipher.final(),
  ]).toString("utf8");
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
    return null; // encrypted value but no key in this environment — treat as unset
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
