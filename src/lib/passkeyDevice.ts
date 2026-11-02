"use client";

import { startRegistration } from "@simplewebauthn/browser";

/**
 * What THIS browser remembers about signing in. Browser-only, and nothing in
 * here ever asks the server anything.
 *
 * That is the security property: "does this email have a passkey?" asked of
 * the server would tell a stranger whether the account exists. So the login
 * page decides "passkey first" from a flag this device set itself, after it
 * really did sign in with, or register, a passkey.
 *
 * Only an email (and only when the person ticked "remember") and two "1"
 * flags are ever stored. Never a password, never a token. Every storage access
 * is wrapped: private windows and blocked site data throw, and the sign-in
 * page must work without any of this.
 */
const REMEMBERED_EMAIL = "crm.login.email";
const PASSKEY_ON_DEVICE = "crm.passkey.onThisDevice";
const DONT_ASK_PASSKEY = "crm.passkey.dontAsk";
/** sessionStorage: a password sign-in was submitted from this tab. */
const PASSWORD_SIGN_IN = "crm.login.passwordSignIn";

function read(storage: "localStorage" | "sessionStorage", key: string): string | null {
  try {
    return window[storage].getItem(key);
  } catch {
    return null;
  }
}

function write(storage: "localStorage" | "sessionStorage", key: string, value: string | null) {
  try {
    if (value === null) window[storage].removeItem(key);
    else window[storage].setItem(key, value);
  } catch {
    // Storage unavailable: the feature quietly does nothing.
  }
}

export const rememberedEmail = () => read("localStorage", REMEMBERED_EMAIL) ?? "";
export const forgetEmail = () => write("localStorage", REMEMBERED_EMAIL, null);

export const passkeyOnThisDevice = () => read("localStorage", PASSKEY_ON_DEVICE) === "1";
export const markPasskeyOnThisDevice = () => write("localStorage", PASSKEY_ON_DEVICE, "1");

export const dontAskForPasskey = () => read("localStorage", DONT_ASK_PASSKEY) === "1";
export const stopAskingForPasskey = () => write("localStorage", DONT_ASK_PASSKEY, "1");

/** Fingerprint, face or device PIN built into this device — a local check, no server call. */
export async function platformAuthenticatorAvailable(): Promise<boolean> {
  try {
    return typeof window.PublicKeyCredential !== "undefined"
      && (await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

/**
 * Noted when the password form is SUBMITTED, acted on only when the app loads.
 *
 * The password action redirects on success, so the login page never learns
 * that it worked; reaching the signed-in app is the proof. The email rides
 * along only when "remember" is ticked; otherwise the note says "forget it".
 */
export function notePasswordSignIn(email: string, remember: boolean) {
  write("sessionStorage", PASSWORD_SIGN_IN, JSON.stringify({ email: remember ? email : null }));
}
export const dropPasswordSignIn = () => write("sessionStorage", PASSWORD_SIGN_IN, null);

/** Signed-in side: settle the remembered email. True when a password sign-in just happened in this tab. */
export function settlePasswordSignIn(): boolean {
  const raw = read("sessionStorage", PASSWORD_SIGN_IN);
  if (raw === null) return false;
  dropPasswordSignIn();
  let email: unknown = null;
  try {
    email = (JSON.parse(raw) as { email?: unknown }).email;
  } catch {}
  write("localStorage", REMEMBERED_EMAIL, typeof email === "string" && email ? email : null);
  return true;
}

/** Register a passkey for the signed-in person (the same routes My Account uses). */
export async function registerPasskey(nickname: string): Promise<void> {
  const optRes = await fetch("/api/auth/passkey/register/options", { method: "POST" });
  if (!optRes.ok) throw new Error("Could not start enrolment.");
  const options = await optRes.json();

  let attestation;
  try {
    attestation = await startRegistration({ optionsJSON: options });
  } catch (e) {
    // This device already holds one of their passkeys: true is true either way.
    if (e instanceof Error && e.name === "InvalidStateError") markPasskeyOnThisDevice();
    throw e;
  }

  const verifyRes = await fetch("/api/auth/passkey/register/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response: attestation, nickname }),
  });
  const data = await verifyRes.json();
  if (!verifyRes.ok) throw new Error(data.error ?? "Enrolment failed.");
  markPasskeyOnThisDevice();
}

export const defaultPasskeyNickname = () =>
  /iPhone|iPad|Android/.test(navigator.userAgent) ? "Phone" : "This device";
