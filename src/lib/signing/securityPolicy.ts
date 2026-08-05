import "server-only";
import crypto from "crypto";

export type SigningSecurityMode = "strict" | "compat";

export function signingSecurityMode(): SigningSecurityMode {
  const configured = (process.env.SIGNING_SECURITY_MODE ?? "").trim().toLowerCase();
  if (configured === "compat") return "compat";
  if (configured === "strict") return "strict";
  // New production deployments fail closed. Local/test stays usable without a
  // private Blob store or production certificate.
  return process.env.NODE_ENV === "production" ? "strict" : "compat";
}

export type SigningReadiness = {
  ready: boolean;
  mode: SigningSecurityMode;
  failures: string[];
};

export function signingReadiness(): SigningReadiness {
  const mode = signingSecurityMode();
  if (mode === "compat") return { ready: true, mode, failures: [] };

  const failures: string[] = [];
  if (process.env.BLOB_PRIVATE !== "true") failures.push("BLOB_PRIVATE must be true");
  if (!process.env.BLOB_PRIVATE_READ_WRITE_TOKEN) failures.push("private Blob credentials are missing");
  if (!process.env.BUILDER_SIGN_P12_BASE64) failures.push("trusted PDF signing certificate is missing");
  if (!process.env.BUILDER_SIGN_P12_PASSPHRASE) failures.push("PDF signing certificate passphrase is missing");
  if (!process.env.SETTINGS_ENCRYPTION_KEY) failures.push("SETTINGS_ENCRYPTION_KEY is missing");
  if (!process.env.SIGNING_OTP_SECRET && !process.env.SESSION_SECRET) failures.push("signing OTP secret is missing");
  if ((process.env.TENANT_ENFORCEMENT ?? "").toLowerCase() !== "enforce") {
    failures.push("TENANT_ENFORCEMENT must be enforce");
  }
  const base = process.env.SIGN_BASE_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!base || !base.startsWith("https://")) failures.push("SIGN_BASE_URL must be an https URL");
  if (!process.env.CRON_SECRET) failures.push("CRON_SECRET is missing");

  return { ready: failures.length === 0, mode, failures };
}

export function assertSigningRuntimeReady(context: string): void {
  const status = signingReadiness();
  if (!status.ready) {
    throw new Error(`Signing is not production-ready for ${context}: ${status.failures.join("; ")}`);
  }
}

/** SHA-256 lookup digest for high-entropy bearer tokens. */
export function bearerTokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function otpSecret(): string {
  const secret = process.env.SIGNING_OTP_SECRET || process.env.SESSION_SECRET;
  if (!secret) throw new Error("Signing OTP secret is not configured");
  return secret;
}

export function signingOtpHash(tenantId: string, recipientId: string, code: string): string {
  return crypto
    .createHmac("sha256", otpSecret())
    .update(`${tenantId}:${recipientId}:${code}`)
    .digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  if (!/^[a-f0-9]+$/i.test(a) || !/^[a-f0-9]+$/i.test(b) || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
