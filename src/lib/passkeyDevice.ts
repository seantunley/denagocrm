"use client";

import { startRegistration } from "@simplewebauthn/browser";

/**
 * What THIS browser remembers about signing in. Browser-only, and nothing in
 * here ever asks the server anything.
 *
 * That is the security property: "does this email have a passkey?" asked of
 * the server would tell a stranger whether the account exists. So the login
 * page decides "passkey first" from flags this device set itself, after a
 * passkey really did sign someone in here, or was registered here.
 *
 * The flags are per ACCOUNT, not per browser (review of #937): on a shared
 * computer one person's passkey must not fold the password form for the next
 * person, or silence their "add a passkey" offer. Each flag list holds account
 * keys (a SHA-256 of the lower-cased email), never an email. The only email
 * ever stored is the one the person opted to have remembered.
 *
 * Never a password, never a token. Every storage access is wrapped: private
 * windows and blocked site data throw, and the sign-in page must work without
 * any of this.
 */
const REMEMBERED_EMAIL = "crm.login.email";
const PASSKEY_ACCOUNTS = "crm.passkey.accounts";
const NO_PROMPT_ACCOUNTS = "crm.passkey.dontAsk";
/** sessionStorage: how this tab just signed in, settled once the app loads. */
const SIGN_IN_NOTE = "crm.login.signIn";
/** A shared computer sees a handful of people; this only stops the list growing forever. */
const MAX_ACCOUNTS = 20;

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

/**
 * The stored stand-in for an email: SHA-256 (hex) of the trimmed, lower-cased
 * address. Null when there is no email, or no Web Crypto (an http:// origin),
 * in which case every flag reads as "not set".
 */
export async function accountKey(email: string): Promise<string | null> {
  const normalised = email.trim().toLowerCase();
  if (!normalised) return null;
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`crm-passkey-account:${normalised}`));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

function readKeys(list: string): string[] {
  try {
    const parsed: unknown = JSON.parse(read("localStorage", list) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

async function listed(list: string, email: string): Promise<boolean> {
  const key = await accountKey(email);
  return key !== null && readKeys(list).includes(key);
}

async function addTo(list: string, email: string): Promise<void> {
  const key = await accountKey(email);
  if (key === null) return;
  const others = readKeys(list).filter((entry) => entry !== key);
  write("localStorage", list, JSON.stringify([...others, key].slice(-MAX_ACCOUNTS)));
}

/** This account has signed in with, or registered, a passkey on this device. */
export const hasPasskeyHere = (email: string) => listed(PASSKEY_ACCOUNTS, email);
export const markPasskeyHere = (email: string) => addTo(PASSKEY_ACCOUNTS, email);

/** This account said "don't ask again" to the add-a-passkey offer on this device. */
export const promptSilencedFor = (email: string) => listed(NO_PROMPT_ACCOUNTS, email);
export const silencePromptFor = (email: string) => addTo(NO_PROMPT_ACCOUNTS, email);

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
 * Noted on the login page, acted on only when the signed-in app loads.
 *
 * The login page never learns WHO signed in (a passkey sign-in names nobody,
 * and the password action redirects on success); reaching the app is the
 * proof it worked, and the app knows the account. A password note carries the
 * email only when "remember" is ticked; otherwise it says "forget it".
 */
export function notePasswordSignIn(email: string, remember: boolean) {
  write("sessionStorage", SIGN_IN_NOTE, JSON.stringify({ via: "password", email: remember ? email : null }));
}
export const notePasskeySignIn = () => write("sessionStorage", SIGN_IN_NOTE, JSON.stringify({ via: "passkey" }));
export const dropSignInNote = () => write("sessionStorage", SIGN_IN_NOTE, null);

/**
 * Signed-in side, once per sign-in: how this tab just signed in. A password
 * sign-in's "remember my email" choice is written (or the email forgotten)
 * only now.
 */
export function settleSignIn(): "password" | "passkey" | null {
  const raw = read("sessionStorage", SIGN_IN_NOTE);
  if (raw === null) return null;
  dropSignInNote();
  let note: { via?: unknown; email?: unknown } = {};
  try {
    note = JSON.parse(raw) ?? {};
  } catch {}
  if (note.via === "passkey") return "passkey";
  if (note.via !== "password") return null;
  write("localStorage", REMEMBERED_EMAIL, typeof note.email === "string" && note.email ? note.email : null);
  return "password";
}

/** Register a passkey for the signed-in person (the same routes My Account uses). */
export async function registerPasskey(nickname: string): Promise<void> {
  const optRes = await fetch("/api/auth/passkey/register/options", { method: "POST" });
  if (!optRes.ok) throw new Error("Could not start enrolment.");
  const options = await optRes.json();
  // The server names the account in the options (user.name is the email), so
  // the flag lands on the right account without asking anything extra.
  const account: string = typeof options?.user?.name === "string" ? options.user.name : "";

  let attestation;
  try {
    attestation = await startRegistration({ optionsJSON: options });
  } catch (e) {
    // This device already holds one of their passkeys: true is true either way.
    if (e instanceof Error && e.name === "InvalidStateError") await markPasskeyHere(account);
    throw e;
  }

  const verifyRes = await fetch("/api/auth/passkey/register/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response: attestation, nickname }),
  });
  const data = await verifyRes.json();
  if (!verifyRes.ok) throw new Error(data.error ?? "Enrolment failed.");
  await markPasskeyHere(account);
}

export const defaultPasskeyNickname = () =>
  /iPhone|iPad|Android/.test(navigator.userAgent) ? "Phone" : "This device";
