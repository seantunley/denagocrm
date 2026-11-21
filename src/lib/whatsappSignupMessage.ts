/**
 * CONNECT WHATSAPP — the browser messages, checked (pure: shared by the popup, the Settings button, the server and the
 * tests). Two hops, each checked by exact origin and shape:
 *   1. Meta's Embedded Signup → our popup (on the platform's own address): `WA_EMBEDDED_SIGNUP` from facebook.com.
 *   2. Our popup → the Settings page that opened it (the workspace's own domain): `honeycomb-wa-signup`.
 * The ids Meta's event carries are for correlation only; the server re-checks them with Meta before trusting them.
 */
export const FACEBOOK_ORIGINS = ["https://www.facebook.com", "https://web.facebook.com"] as const;
export const SIGNUP_MESSAGE_TYPE = "honeycomb-wa-signup";
/** Graph version for the new signup calls (Meta's Embedded Signup v4 samples, 2026-11). One place to move it. */
export const WA_SIGNUP_GRAPH_VERSION = "v27.0";

const ID = /^\d{5,32}$/;

export type SignupSession = { wabaId: string; phoneNumberId: string };
export type SignupHandoff = { state: string; code: string; wabaId: string; phoneNumberId: string };

/**
 * Meta's session event. FINISH (Cloud API) only: CANCEL and ERROR say "not connected", and the Business-app
 * (coexistence) finish is not supported here — South African numbers can't use it.
 */
export function parseMetaSignupEvent(origin: string, data: unknown): { kind: "finish"; session: SignupSession } | { kind: "cancel" | "error" | "unsupported" } | null {
  if (!(FACEBOOK_ORIGINS as readonly string[]).includes(origin)) return null;
  let parsed: unknown = data;
  if (typeof data === "string") {
    try { parsed = JSON.parse(data); } catch { return null; }
  }
  const event = parsed as { type?: unknown; event?: unknown; data?: { waba_id?: unknown; phone_number_id?: unknown } } | null;
  if (!event || event.type !== "WA_EMBEDDED_SIGNUP") return null;
  if (event.event === "CANCEL") return { kind: "cancel" };
  if (event.event === "ERROR") return { kind: "error" };
  if (event.event !== "FINISH") return { kind: "unsupported" };
  const wabaId = String(event.data?.waba_id ?? "");
  const phoneNumberId = String(event.data?.phone_number_id ?? "");
  return ID.test(wabaId) && ID.test(phoneNumberId) ? { kind: "finish", session: { wabaId, phoneNumberId } } : { kind: "error" };
}

/** Hop 2: what the popup hands back to Settings — accepted only from the platform's own address, in this exact shape. */
export function parseSignupHandoff(origin: string, platformOrigin: string, data: unknown): SignupHandoff | null {
  if (origin !== platformOrigin) return null;
  const message = data as { type?: unknown } | null;
  if (!message || message.type !== SIGNUP_MESSAGE_TYPE) return null;
  return validHandoff(message);
}

/** The handoff's fields, well-formed — checked again on the server, whatever the browser says. */
export function validHandoff(data: unknown): SignupHandoff | null {
  const { state, code, wabaId, phoneNumberId } = (data ?? {}) as { state?: unknown; code?: unknown; wabaId?: unknown; phoneNumberId?: unknown };
  if (typeof state !== "string" || !/^[a-z0-9]{8,40}\.[A-Za-z0-9_-]{30,60}$/.test(state)) return null;
  if (typeof code !== "string" || code.length < 10 || code.length > 2048) return null;
  if (typeof wabaId !== "string" || !ID.test(wabaId) || typeof phoneNumberId !== "string" || !ID.test(phoneNumberId)) return null;
  return { state, code, wabaId, phoneNumberId };
}

/** A fresh six-digit two-step verification PIN for registering the number (stored encrypted, never shown). */
export function newRegistrationPin(randomInt: (max: number) => number): string {
  return String(randomInt(1_000_000)).padStart(6, "0");
}
