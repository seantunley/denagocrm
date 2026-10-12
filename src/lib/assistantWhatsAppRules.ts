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
 * Rate limits. registerRateLimitAttempt answers `count < limit`, so the limit is
 * one more than the attempts that pass.
 *
 * CODE REQUESTS — per person. Asking for codes over and over buys nothing (each
 * one replaces the last), but it is a write and an audit row each time.
 *
 * CODE ATTEMPTS — EVERY "DAX nnnnnn" is counted before anything is compared
 * (no check-then-count race), first per sending number, then — only if that
 * number isn't already blocked — across the workspace, so many numbers can't
 * share the guessing and one blocked number can't keep the workspace counter
 * full. A code is 6 digits for 15 minutes: brute force is hopeless, and an
 * attempt past a block is never compared — it is filed as the customer message
 * it is.
 *
 * QUESTIONS are not limited here: they share the person's one ask limit with
 * every other channel (assistantAskAllowed in assistantUser.ts).
 */
export const LINK_CODE_POLICY: RateLimitPolicy = { limit: 6, windowMs: 15 * 60 * 1000, blockMs: 15 * 60 * 1000 };
export const LINK_GUESS_POLICY: RateLimitPolicy = { limit: 5, windowMs: 15 * 60 * 1000, blockMs: 30 * 60 * 1000 };
/**
 * And across the whole workspace, so many numbers can't share the guessing.
 * Linking is rare; the worst this does is make a real person wait 15 minutes.
 */
export const LINK_GUESS_WORKSPACE_POLICY: RateLimitPolicy = { limit: 20, windowMs: 15 * 60 * 1000, blockMs: 15 * 60 * 1000 };

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

/**
 * Why a code that DID match was not allowed to link the phone, as the person is
 * told on the Ask page. Never sent to the phone itself: a refused number may be
 * a customer's, and a customer is not messaged about our linking.
 */
export const LINK_REFUSALS = {
  customer_number:
    "That phone wasn't linked: its number is saved on a customer or an open lead in this workspace. Take the number off that record, or use a different phone, then ask for a new code.",
  signed_out: "That code wasn't accepted because your sign-ins were reset after you asked for it. Ask for a new code.",
} as const;
export type LinkRefusal = keyof typeof LINK_REFUSALS;
export const linkRefusalText = (reason: string | null | undefined): string | null =>
  reason && reason in LINK_REFUSALS ? LINK_REFUSALS[reason as LinkRefusal] : null;

/*
 * ── CONFIRMING A TASK ON WHATSAPP ───────────────────────────────────────────
 *
 * The assistant never changes anything itself: it proposes, a person confirms.
 * In the CRM that is a card with a Confirm button. On WhatsApp it is a message
 * with a Confirm button — when the workspace owner has switched this on. The
 * tap is the person's click; without it nothing happens.
 */

/** The owner's switch (AppSetting). Absent or anything but "on" is OFF. */
export const ASSISTANT_WHATSAPP_CONFIRM_KEY = "ASSISTANT_WHATSAPP_CONFIRM";
export const whatsappConfirmOn = (raw: string | null | undefined): boolean => raw === "on";

/** How long a proposed task can still be confirmed. After that: ask again. */
export const PENDING_ACTION_TTL_MS = 15 * 60 * 1000;

/**
 * What may be confirmed from a phone: changes INSIDE the CRM only.
 *
 * Left out on purpose, and they stay in the CRM:
 *  - draft_message — a message to a customer. It is read, edited and sent by the
 *    person, on the record, never from a chat with the assistant;
 *  - test_drive — books a customer onto a vehicle;
 *  - lost, quote — closing a deal and starting a quote deserve the screen.
 * A kind not named here is not confirmable: a new kind is CRM-only until someone
 * decides otherwise.
 */
export const WHATSAPP_CONFIRMABLE: ReadonlySet<string> = new Set([
  "note", "customer_note", "follow_up", "assign", "stage", "meeting", "reschedule", "cancel_activity", "schedule", "watch",
]);

/** Proposed cards, split into those that get a Confirm button here and those that need the CRM. */
export function splitForWhatsApp_cards<T extends { kind: string }>(cards: readonly T[]): { confirmable: T[]; crmOnly: T[] } {
  return {
    confirmable: cards.filter((card) => WHATSAPP_CONFIRMABLE.has(card.kind)),
    crmOnly: cards.filter((card) => !WHATSAPP_CONFIRMABLE.has(card.kind)),
  };
}

/** The Confirm button's id: names the pending row and nothing else. */
export const confirmButtonId = (pendingId: string) => `daxc:${pendingId}`;
/** A tapped button's id → the pending row it names, or null when it is not a Confirm button of ours. */
export function parseConfirmId(choiceId: string | null | undefined): string | null {
  const match = /^daxc:(c[a-z0-9]{20,40})$/.exec(String(choiceId ?? ""));
  return match ? match[1] : null;
}

/**
 * What the person is shown before they can tap Confirm — ALL of it, or nothing.
 *
 * THE RULE: what Confirm writes is exactly what was shown. A button message's
 * body holds 1,024 characters and a note can be 2,000, so the first version cut
 * the prompt to fit: the person confirmed a note whose second half they had
 * never seen. Nothing here is ever truncated. When the whole thing fits the
 * button message, that is all there is. When it does not, the full text goes
 * first as ordinary messages (4,096 characters each, split on a boundary and
 * never dropped) and the button message points back at them. When even the
 * pointer cannot be shown whole, there is no button at all (null): that task is
 * confirmed in the CRM.
 *
 * Every field of a card that the person would otherwise be agreeing to unseen
 * is listed here: a note's text, a scheduled question, a meeting's detail.
 */
export function confirmMessages(card: { title: string; text?: unknown; question?: unknown; detail?: unknown; reason?: unknown }): { before: string[]; body: string } | null {
  const shown = [card.title, card.text, card.question, card.detail, card.reason]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim());
  const footer = `Tap Confirm within ${PENDING_ACTION_TTL_MS / 60_000} minutes and I'll do it. Nothing changes until you do.`;
  const whole = [...shown, footer].join("\n\n");
  if (whole.length <= WA_BODY_MAX) return { before: [], body: whole };
  const before = splitForWhatsApp(shown.join("\n\n"));
  const body = `${card.title.trim()}\n\nThe full text is in the message${before.length === 1 ? "" : "s"} above — read ${before.length === 1 ? "it" : "them"} first. ${footer}`;
  return body.length <= WA_BODY_MAX ? { before, body } : null;
}

/*
 * ── WHAT THE ASSISTANT SENDS ON ITS OWN ─────────────────────────────────────
 *
 * A scheduled briefing or a watch alert, sent to the person's linked phone as
 * well as their history. Nobody asked a question just then, so WhatsApp's
 * 24-hour rule decides whether a message is accepted at all — see
 * sendUpdatesToLinkedPhone.
 */

/** The kinds of answer nobody was waiting on a screen for. */
export const PROACTIVE_SOURCES = ["schedule", "watch"] as const;
/** How long an update keeps trying to reach WhatsApp. After a day it is old news: it stays in the CRM only. */
export const UPDATE_WAIT_MS = 24 * 60 * 60 * 1000;
/** At most this many in one go, oldest first — a morning's worth, not a backlog. */
export const UPDATE_BATCH = 5;
/** One "you have an update" template per silence, and never more often than this. */
export const NUDGE_EVERY_MS = 20 * 60 * 60 * 1000;

/**
 * The owner's setting (AppSetting): the approved template to send when WhatsApp
 * will take nothing else. Stored as "name" or "name|language" — the template's
 * name exactly as it is in WhatsApp Manager, and its language code (en, en_US,
 * af…). Blank = no template: updates then reach a phone only inside 24 hours.
 */
export const ASSISTANT_WHATSAPP_TEMPLATE_KEY = "ASSISTANT_WHATSAPP_TEMPLATE";
export function parseUpdateTemplate(raw: string | null | undefined): { name: string; language: string } | null {
  const [name, language] = String(raw ?? "").split("|").map((part) => part.trim());
  // Meta's own shape: lower-case letters, digits and underscores; a language like en or en_US.
  if (!/^[a-z0-9_]{1,512}$/.test(name ?? "")) return null;
  return { name, language: /^[a-z]{2,3}(_[A-Z]{2})?$/.test(language ?? "") ? language : "en" };
}
export const formatUpdateTemplate = (name: string, language: string) => `${name.trim()}|${language.trim() || "en"}`;

/**
 * May a free message be sent now? Only within 24 hours of the person's last
 * message — less a margin, so one sent at 23:59 is not failed at 24:01. WE keep
 * that time: Meta usually accepts a late message and fails it afterwards, by
 * which time it would have been marked as delivered. Never written = closed.
 */
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000 - 10 * 60 * 1000;
export const replyWindowOpen = (lastInboundAt: Date | null | undefined, now = Date.now()): boolean =>
  Boolean(lastInboundAt) && now - lastInboundAt!.getTime() < REPLY_WINDOW_MS;

/** Was a send refused because the person has not written in the last 24 hours? (Meta 131047, and our own wording of it.) */
export const outsideReplyWindow = (error: string | null | undefined): boolean => /131047|24-hour|24 hours|re-?engag/i.test(String(error ?? ""));

/** An update as it is sent: what it is, then all of it. */
export function updateText(turn: { source: string; question: string; answer: string }): string {
  const heading = turn.source === "watch" ? `👀 You asked me to watch: ${turn.question.trim()}` : `⏰ Scheduled: ${turn.question.trim()}`;
  return `${heading}\n\n${turn.answer.trim()}`;
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
