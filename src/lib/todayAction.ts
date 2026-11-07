/**
 * Today's one-click actions — the PURE half: which channels a row may use and why
 * not, what the message says to begin with, and when the next step falls. The page
 * computes these per row; TodayAction (the client panel) only shows and sends them.
 *
 * No `server-only`: tests run these directly, and nothing here touches data.
 */
import { johannesburgDateKey } from "./activityDay";

export type TodayChannel = "call" | "whatsapp" | "email";
export type ChannelState = { ok: true } | { ok: false; reason: string };

/** WhatsApp's own rule: a business may write freely only within 24 hours of the customer's last message. */
export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

export const CALL_OUTCOMES = [
  { value: "reached", label: "Spoke to them" },
  { value: "callback", label: "They asked me to call back" },
  { value: "no_answer", label: "No answer" },
  { value: "voicemail", label: "Left a voicemail" },
  { value: "wrong_number", label: "Wrong number" },
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number]["value"];

export function callOutcomeLabel(outcome: string): string {
  return CALL_OUTCOMES.find((item) => item.value === outcome)?.label ?? "Call";
}

export function todayChannels(input: {
  email: string | null;
  phone: string | null;
  /** The customer's last WhatsApp to us — the only thing that opens WhatsApp's 24 hours. */
  lastWhatsAppInboundAt: Date | null;
  canWriteRecord: boolean;
  canWhatsApp: boolean;
  smtpConfigured: boolean;
  whatsappConfigured: boolean;
  now: Date;
}): Record<TodayChannel, ChannelState> {
  const role = (what: string): ChannelState => ({ ok: false, reason: `Your role can't ${what} on this deal.` });
  const windowOpen =
    input.lastWhatsAppInboundAt !== null && input.now.getTime() - input.lastWhatsAppInboundAt.getTime() < WHATSAPP_WINDOW_MS;
  return {
    call: input.canWriteRecord ? { ok: true } : role("log calls"),
    email: !input.canWriteRecord
      ? role("send email")
      : !input.smtpConfigured
        ? { ok: false, reason: "Email isn't set up yet (Settings → Email)." }
        : !input.email
          ? { ok: false, reason: "No email address on this deal or its customer." }
          : { ok: true },
    whatsapp: !input.canWhatsApp
      ? role("send WhatsApp messages")
      : !input.whatsappConfigured
        ? { ok: false, reason: "WhatsApp isn't connected (Settings → Integrations)." }
        : !input.phone
          ? { ok: false, reason: "No phone number on this deal or its customer." }
          : !windowOpen
            ? { ok: false, reason: "WhatsApp only allows a free message within 24 hours of their last WhatsApp. Call or email instead." }
            : { ok: true },
  };
}

/** The channel the row opens on: what the action asks for, falling back to whatever is usable. */
export function defaultChannel(action: string, channels: Record<TodayChannel, ChannelState>): TodayChannel {
  const reply = /^(Reply to their message|Keep the conversation going)/.test(action);
  const quote = action === "Follow up on the quote";
  const order: TodayChannel[] = reply ? ["whatsapp", "email", "call"] : quote ? ["email", "call", "whatsapp"] : ["call", "email", "whatsapp"];
  return order.find((channel) => channels[channel].ok) ?? "call";
}

/** Plain text → the composer's HTML body: escaped, a paragraph per blank-line block. */
export function textToEmailHtml(text: string): string {
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return text
    .trim()
    .split(/\n{2,}/)
    .map((block) => `<p>${escape(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/**
 * The message the row opens with. Written to be sent as-is or edited — never sent
 * without the rep pressing Send. The email signature is added by the composer, so
 * the email ends at "Kind regards".
 */
export function todayDrafts(input: {
  action: string;
  firstName: string;
  opportunity: string | null;
  quoteNumber: number | null;
  senderFirstName: string;
  company: string;
}): { email: { subject: string; body: string }; whatsapp: string } {
  const hi = `Hi ${input.firstName},`;
  const the = input.opportunity ? ` the ${input.opportunity}` : "";
  const quote = input.quoteNumber ? ` (Q-${input.quoteNumber})` : "";
  const me = `${input.senderFirstName} from ${input.company}`;

  if (input.action === "Follow up on the quote" || input.action === "Call while the quote is fresh") {
    return {
      email: {
        subject: `Your quote${input.quoteNumber ? ` Q-${input.quoteNumber}` : ""}${input.opportunity ? ` – ${input.opportunity}` : ""}`,
        body: `${hi}\n\nJust checking in on the quote${quote} I sent you${input.opportunity ? ` for${the}` : ""}. Is there anything I can answer, or anything you'd like changed?\n\nKind regards`,
      },
      whatsapp: `${hi} it's ${me}. Just checking in on your quote${quote}. Any questions I can help with?`,
    };
  }
  if (input.action === "Make first contact") {
    return {
      email: {
        subject: `Your enquiry${input.opportunity ? ` about${the}` : ""}`,
        body: `${hi}\n\nThank you for your enquiry${input.opportunity ? ` about${the}` : ""}. When would suit you for a quick call to go through your options?\n\nKind regards`,
      },
      whatsapp: `${hi} it's ${me}. Thanks for your enquiry${input.opportunity ? ` about${the}` : ""}. When would suit you for a quick call?`,
    };
  }
  if (/^(Reply to their message|Keep the conversation going)/.test(input.action)) {
    return {
      email: { subject: `Re: ${input.opportunity ?? "your message"}`, body: `${hi}\n\n\n\nKind regards` },
      whatsapp: `${hi} `,
    };
  }
  return {
    email: {
      subject: `Checking in${input.opportunity ? ` – ${input.opportunity}` : ""}`,
      body: `${hi}\n\nJust checking in${input.opportunity ? ` on${the}` : ""}. Is there anything I can help with?\n\nKind regards`,
    },
    whatsapp: `${hi} it's ${me}. Just checking in${input.opportunity ? ` on${the}` : ""}. Anything I can help with?`,
  };
}

/** `days` working days after `now`'s Johannesburg day, as YYYY-MM-DD (Saturday and Sunday skipped). */
export function addWorkingDays(now: Date, days: number): string {
  const date = new Date(`${johannesburgDateKey(now)}T12:00:00Z`);
  let left = days;
  while (left > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) left -= 1;
  }
  return date.toISOString().slice(0, 10);
}

/**
 * The next step the row books, prefilled and editable. Sooner when nobody was
 * reached; later when a quote is with them to read.
 */
export function nextStepDefault(action: string, now: Date, quoteNumber: number | null): { date: string; summary: string } {
  const quote = action === "Follow up on the quote" || action === "Call while the quote is fresh";
  return {
    date: addWorkingDays(now, action === "Make first contact" ? 1 : quote ? 3 : 2),
    summary: quote ? `Follow up on quote${quoteNumber ? ` Q-${quoteNumber}` : ""}` : "Follow-up call",
  };
}

/** After a call that reached nobody, try again the next working day whatever the default was. */
export function nextStepAfterCall(outcome: string, defaultDate: string, now: Date): string {
  return outcome === "no_answer" || outcome === "voicemail" ? addWorkingDays(now, 1) : defaultDate;
}

/**
 * HANDLED TODAY: we reached the customer today (a message we sent, or a call or
 * meeting we logged) and they haven't written since. Such a deal leaves Today until
 * tomorrow, or until they reply — the "row leaves the list when done" rule, held on
 * the server so a refresh doesn't bring it back.
 */
export function handledToday(ourLastTouchAt: Date | null, lastInboundAt: Date | null, now: Date): boolean {
  if (!ourLastTouchAt) return false;
  if (johannesburgDateKey(ourLastTouchAt) !== johannesburgDateKey(now)) return false;
  return lastInboundAt === null || lastInboundAt.getTime() <= ourLastTouchAt.getTime();
}
