import "server-only";
import crypto from "crypto";

export type SigningSecurityMode = "strict" | "compat";

/**
 * Strict mode is an EXPLICIT choice, never inferred from the environment.
 *
 * An earlier draft returned "strict" whenever NODE_ENV was production. That
 * reads as a safe default and is the opposite: strict additionally requires a
 * private Blob store, a purchased signing certificate and TENANT_ENFORCEMENT,
 * none of which are configured today — so merging it would have made the very
 * next signature completion throw in production, while every test and CI run
 * (NODE_ENV=test) passed. A security posture that engages on deploy rather than
 * on decision is a posture nobody has actually agreed to.
 *
 * So: opt in with SIGNING_SECURITY_MODE=strict, once the runbook's prerequisites
 * are in place. Until then signing keeps working exactly as it does now — which
 * is not "insecure", it is the system that is live today, plus this branch's
 * hashed capabilities, verified identity and tamper-evident evidence, none of
 * which are gated on strict mode.
 */
export function signingSecurityMode(): SigningSecurityMode {
  return (process.env.SIGNING_SECURITY_MODE ?? "").trim().toLowerCase() === "strict" ? "strict" : "compat";
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
  // TENANT_ENFORCEMENT is deliberately NOT required here.
  //
  // Flipping the platform-wide tenancy enforcement switch is its own project
  // with its own runbook and its own rollback plan. Making it a precondition of
  // signing would mean a signing release could only ship by carrying out an
  // unrelated, higher-risk migration on the same day — and would quietly hand
  // whoever wants strict sealing the power to trigger it.
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
