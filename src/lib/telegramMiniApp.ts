import crypto from "crypto";
import { getSetting } from "./settings";

/**
 * Telegram Mini App (Web App) initData validation.
 *
 * Telegram signs the launch payload with the bot token so a Mini App can prove,
 * server-side, *which* Telegram user opened it — without any password. The
 * algorithm (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 *
 *   secret_key = HMAC_SHA256(key = "WebAppData", data = <bot_token>)
 *   hash       = HMAC_SHA256(key = secret_key,   data = <data_check_string>)
 *
 * where data_check_string is every field except `hash`, as `key=value`, sorted
 * by key and joined with "\n". We compare in constant time and reject stale
 * payloads to blunt replay.
 */

export type TelegramMiniAppUser = {
  id: string; // Telegram numeric user id, as a string (it can exceed 2^53)
  firstName: string;
  lastName: string | null;
  username: string | null;
  photoUrl: string | null;
};

export type InitDataResult =
  | { ok: true; user: TelegramMiniAppUser; authDate: number }
  | { ok: false; reason: "no_token" | "malformed" | "bad_hash" | "expired" | "no_user" };

// Reject launch payloads older than this. Telegram refreshes initData on each
// open, so a generous-but-bounded window is safe and avoids clock-skew grief.
const MAX_AGE_SECONDS = 24 * 60 * 60;

export async function validateInitData(initData: string): Promise<InitDataResult> {
  const botToken = await getSetting("TELEGRAM_BOT_TOKEN");
  if (!botToken) return { ok: false, reason: "no_token" };
  if (!initData || typeof initData !== "string") return { ok: false, reason: "malformed" };

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "malformed" };

  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === "hash") continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_hash" };
  }

  const authDate = Number(params.get("auth_date") ?? 0);
  if (!authDate || Math.floor(Date.now() / 1000) - authDate > MAX_AGE_SECONDS) {
    return { ok: false, reason: "expired" };
  }

  const rawUser = params.get("user");
  if (!rawUser) return { ok: false, reason: "no_user" };
  let parsed: { id?: number; first_name?: string; last_name?: string; username?: string; photo_url?: string };
  try {
    parsed = JSON.parse(rawUser);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!parsed.id) return { ok: false, reason: "no_user" };

  return {
    ok: true,
    authDate,
    user: {
      id: String(parsed.id),
      firstName: parsed.first_name ?? "",
      lastName: parsed.last_name ?? null,
      username: parsed.username ?? null,
      photoUrl: parsed.photo_url ?? null,
    },
  };
}

/** Best-effort bot username (for showing the concrete t.me link in Settings). Null if no token / offline. */
export async function getBotUsername(): Promise<string | null> {
  const botToken = await getSetting("TELEGRAM_BOT_TOKEN");
  if (!botToken) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
      signal: AbortSignal.timeout(5000),
    });
    const j = await res.json().catch(() => null);
    return j?.ok && j.result?.username ? String(j.result.username) : null;
  } catch {
    return null;
  }
}

/** A short, unambiguous one-time code the user copies from web Settings into the Mini App. */
export function generateLinkCode(): string {
  // Crockford-ish alphabet: no 0/O/1/I/L to avoid transcription errors.
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length];
  return code;
}
