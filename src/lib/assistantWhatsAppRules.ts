/**
 * DAX on WhatsApp — the rules, with nothing attached.
 *
 * Everything here is pure (no database, no network, no `server-only`) so the
 * parts that decide WHO a message is from and WHAT goes back can be tested on
 * their own. The webhook side lives in assistantWhatsApp.ts; the person's own
 * controls in app/actions/assistantWhatsApp.ts.
 *
 * ── THE THREAT THIS FEATURE HAS TO CLOSE ────────────────────────────────────
 *
 * The business number is the number CUSTOMERS message. Answering a message on it
 * as staff sends CRM data — other customers' names, quotes, the pipeline — to
 * whoever sent it. So a number is staff only when it has been PROVEN: the person,
 * signed in to the CRM, asks for a one-time code, and that code arrives FROM the
 * number. A typed-in number is a claim anyone can make; possession of the phone
 * is not. Everything else fails towards "customer", which is exactly today's
 * behaviour.
 */
import type { RateLimitPolicy } from "./rateLimit";
import { WA_BODY_MAX, WA_BUTTON_MAX, WA_BUTTON_TITLE_MAX, WA_TEXT_MAX } from "./whatsappRendering";

/** The workspace switch (AppSetting). Absent or anything but "on" is OFF. */
export const ASSISTANT_WHATSAPP_KEY = "ASSISTANT_WHATSAPP";
export const whatsappSwitchOn = (raw: string | null | undefined): boolean => raw === "on";

/** How long a link code may be used. Short: it only has to survive one copy-and-send. */
export const LINK_CODE_TTL_MS = 15 * 60 * 1000;

/**
 * Rate limits. registerRateLimitAttempt answers `count < limit`, so where that
 * answer is used (code requests, questions) the limit is one more than the
 * attempts that pass. Guesses use checkRateLimit instead, which blocks once the
 * count REACHES the limit — so there the limit is the number of wrong guesses.
 *
 * CODE REQUESTS — per person. Asking for codes over and over buys nothing (each
 * one replaces the last), but it is a write and an audit row each time.
 *
 * CODE GUESSES — per sending number, failures only. A code is 6 digits for 15
 * minutes; five wrong guesses then a 30-minute block makes guessing one by
 * brute force hopeless (≈ 5 in a million per window), and a guess past the
 * block is never even compared — it is filed as the customer message it is.
 *
 * QUESTIONS are not limited here: they share the person's one ask limit with
 * every other channel (assistantAskAllowed in assistantUser.ts).
 */
export const LINK_CODE_POLICY: RateLimitPolicy = { limit: 6, windowMs: 15 * 60 * 1000, blockMs: 15 * 60 * 1000 };
export const LINK_GUESS_POLICY: RateLimitPolicy = { limit: 5, windowMs: 15 * 60 * 1000, blockMs: 30 * 60 * 1000 };

/** What a person may ask in one message — the same cap the Ask page uses. */
export const QUESTION_CHARS = 500;

/** A number from crypto.randomInt(0, 1_000_000) → the six digits people type. */
export function formatLinkCode(n: number): string {
  return String(Math.trunc(n)).padStart(6, "0").slice(-6);
}

/** What the person sends, word for word. */
export const linkCodeText = (code: string) => `DAX ${code}`;

/** "DAX 123456" (any case, spaces around) → "123456"; anything else → null. */
export function parseLinkCode(text: string | null | undefined): string | null {
  const m = /^\s*DAX\s+(\d{6})\s*$/i.exec(String(text ?? ""));
  return m ? m[1] : null;
}

/**
 * What gets sha256-hashed and stored instead of the code. The workspace and the
 * person are part of it, so a stored hash is useless for any other row: the same
 * code issued to someone else, or in another workspace, hashes differently.
 */
export function linkCodeHashInput(tenantId: string, userId: string, code: string): string {
  return `assistant-whatsapp-link\u0000${tenantId}\u0000${userId}\u0000${code}`;
}

/** A linked number as it is shown back: the last three digits only. */
export function maskWaId(waId: string | null | undefined): string {
  const digits = String(waId ?? "").replace(/\D/g, "");
  return digits.length >= 3 ? `•••${digits.slice(-3)}` : "•••";
}

/**
 * The business WhatsApp number, read from the endpoint's label. Registration
 * stores "Verified name · +27 21 123 4567" (whatsappLabelFrom); nothing stores
 * the number on its own. Null when the label has no number — the page then says
 * "the business WhatsApp number" and the link opens WhatsApp without one.
 */
export function businessNumberFromLabel(label: string | null | undefined): { display: string; digits: string } | null {
  for (const part of String(label ?? "").split("·").reverse()) {
    const display = part.trim();
    const digits = display.replace(/\D/g, "");
    if (/^\+?[\d\s()-]+$/.test(display) && digits.length >= 8 && digits.length <= 15) return { display, digits };
  }
  return null;
}

/** wa.me with the code already typed, to the business number when we know it. */
export function waMeLink(businessDigits: string | null | undefined, code: string): string {
  return `https://wa.me/${businessDigits ?? ""}?text=${encodeURIComponent(linkCodeText(code))}`;
}

/**
 * A long answer → messages WhatsApp will take whole. Cut at a paragraph, else a
 * line, else a space, as late as possible; a run with none of those is cut hard.
 * sendWhatsAppText slices at the limit, so without this the end of a long
 * answer would simply vanish.
 */
export function splitForWhatsApp(text: string, max = WA_TEXT_MAX): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = window.lastIndexOf("\n\n");
    if (cut < max / 2) cut = window.lastIndexOf("\n");
    if (cut < max / 2) cut = window.lastIndexOf(" ");
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

export type WhatsAppReplyPlan = {
  /** Plain text messages, in order. */
  texts: string[];
  /** Then, optionally, one message of reply buttons — tapped, a title is the next question. */
  buttons: { body: string; titles: string[] } | null;
};

/**
 * An answer and its quick replies → what to send. Reply buttons only when they
 * fit WhatsApp's rules (at most three, titles at most 20 characters) — cutting a
 * title would change the question it asks when tapped. Anything else becomes a
 * numbered list at the end of the text, to answer by typing.
 *
 * Short answers ride as the buttons' own body (one message); a button body is
 * capped at 1024, so a longer answer goes as text first, then the buttons.
 */
export function planWhatsAppReply(answer: string, choices: readonly string[] = []): WhatsAppReplyPlan {
  const text = answer.trim() || "I couldn't put an answer together just now — try asking again.";
  const options = [...new Set(choices.map((c) => c.trim()).filter(Boolean))];
  if (!options.length) return { texts: splitForWhatsApp(text), buttons: null };
  if (options.length <= WA_BUTTON_MAX && options.every((o) => o.length <= WA_BUTTON_TITLE_MAX)) {
    if (text.length <= WA_BODY_MAX) return { texts: [], buttons: { body: text, titles: options } };
    return { texts: splitForWhatsApp(text), buttons: { body: "Tap one, or just ask:", titles: options } };
  }
  const list = options.map((o, i) => `${i + 1}. ${o}`).join("\n");
  return { texts: splitForWhatsApp(`${text}\n\n${list}`), buttons: null };
}
