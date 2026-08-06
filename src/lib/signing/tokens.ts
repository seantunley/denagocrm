import crypto from "crypto";
import { isProductionRuntime } from "./securityConfig";

/** Raw public capability: 224 bits of entropy, represented as 56 lowercase hex chars. */
export function newSignToken(): string {
  return crypto.randomBytes(28).toString("hex");
}

export const SIGN_TOKEN_RE = /^[a-f0-9]{48,64}$/;
export const STORED_TOKEN_DIGEST_RE = /^[a-f0-9]{64}$/;

export function isValidSignToken(token: string): boolean {
  return SIGN_TOKEN_RE.test(token);
}

export function hashSignToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken, "utf8").digest("hex");
}

function tokenKey(): Buffer {
  const configured = process.env.SIGNING_TOKEN_ENCRYPTION_KEY;
  if (configured) {
    const decoded = /^[a-f0-9]{64}$/i.test(configured)
      ? Buffer.from(configured, "hex")
      : Buffer.from(configured, "base64");
    if (decoded.length !== 32) throw new Error("SIGNING_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
    return decoded;
  }
  if (isProductionRuntime()) throw new Error("SIGNING_TOKEN_ENCRYPTION_KEY is required in production");
  return crypto.createHash("sha256").update(process.env.AUTH_SECRET || "denago-local-signing-token-key").digest();
}

export function encryptSignToken(rawToken: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", tokenKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(rawToken, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

export function decryptSignToken(envelope: string): string {
  const [version, ivText, tagText, ciphertextText] = envelope.split(":");
  if (version !== "v1" || !ivText || !tagText || !ciphertextText) throw new Error("Invalid signing capability envelope");
  const decipher = crypto.createDecipheriv("aes-256-gcm", tokenKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export type SignCapability = {
  rawToken: string;
  digest: string;
  ciphertext: string;
  issuedAt: Date;
  expiresAt: Date;
};

export function newSignCapability(daysValid = 30): SignCapability {
  const rawToken = newSignToken();
  const issuedAt = new Date();
  return {
    rawToken,
    digest: hashSignToken(rawToken),
    ciphertext: encryptSignToken(rawToken),
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + daysValid * 24 * 60 * 60 * 1000),
  };
}

export function safeTokenEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
