import crypto from "crypto";

/** Per-recipient signing token — 56 hex chars, matching the existing /sign scheme. */
export function newSignToken(): string {
  return crypto.randomBytes(28).toString("hex");
}

export const SIGN_TOKEN_RE = /^[a-f0-9]{48,64}$/;

export function isValidSignToken(t: string): boolean {
  return SIGN_TOKEN_RE.test(t);
}
