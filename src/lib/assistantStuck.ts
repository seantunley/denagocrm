import type { AttentionSignal } from "./attention/score";
import { dispositionAt, dispositionIsActive, parseAttentionDispositions } from "./attention/dispositions";
import { deliveryStage } from "./daxBriefRules";
import { NEW_LEAD_DAYS, NO_CONTACT_DAYS, agoPhrase, calendarDaysAgo } from "./leadScore";
import { johannesburgDateKey } from "./activityDay";
import { stamp } from "./assistantWhy";
import { nurtureReasonLabel } from "./leadNurture";

/**
 * "Why is this deal stuck?" — the PURE half. assistantStuckLookup.ts reads the rows the person may see and hands
 * them here; the tests drive this directly.
 *
 * The reasons are worked out by FIXED RULES from dated records — never by the model. Most come straight from the
 * Attention Centre's own signals for the deal (attention/signals.ts: a customer waiting on a reply, an overdue
 * follow-up, a quote running out, too long in the stage, no next step), so "stuck" here and on the attention list
 * mean the same thing. The few it has no signal for are read off the records here: a quote whose email bounced, or
 * that the customer never opened, asked to change or declined; a signed deal waiting on its invoice, deposit or
 * delivery (the deliveries board's own rule); our last message going unanswered for as long as the Today queue calls
 * "no contact"; a deal someone parked. Each carries its date and the link to the record it came from, and they are
 * RANKED by what holds a deal up most. The answer step may give only these as reasons; anything else is labelled a
 * guess (STUCK_LEGEND).
 */

/** Most pressing first: the order the reasons are given in. */
export const STUCK_ORDER = [
  "parked",
  "customer_waiting",
  "changes_requested",
  "quote_declined",
  "overdue_task",
  "after_signing",
  "quote_bounced",
  "quote_unopened",
  "quote_expiring",
  "stage_age",
  "no_next_step",
  "customer_quiet",
] as const;
export type StuckKind = (typeof STUCK_ORDER)[number];

/** A sent quote the customer still hasn't opened this many calendar days later is a reason. */
export const QUOTE_UNOPENED_DAYS = 2;

export type StuckReason = {
  kind: StuckKind;
  /** The sentence to give — an attention signal's own, verbatim, where it comes from one. */
  why: string;
  /** The date it rests on: when the customer wrote, the task was due, the quote went out or runs out. */
  date: Date | null;
  link: string;
  /** Someone snoozed or dismissed this warning: when, and the reason they gave. */
  setAside?: string;
};

/** The attention signal → the reason it is here. */
const FROM_SIGNAL: Record<AttentionSignal["kind"], StuckKind> = {
  unanswered_inbound: "customer_waiting",
  overdue_task: "overdue_task",
  quote_expiring: "quote_expiring",
  stage_age: "stage_age",
  no_next_step: "no_next_step",
};

export type StuckQuote = {
  id: string;
  number: number;
  status: string;
  sentAt: Date | null;
  /** It went out as a signing link — the only way the customer OPENING it is recorded (openedAt). */
  viaLink: boolean;
  /** What open-tracking saw of the email that carried it (null: no such email) — an emailed PDF has only this. */
  emailOpen: "opened" | "not_detected" | "untracked" | null;
  /** That email was refused by the customer's mail server (quoteEmailStatus.ts). */
  emailBounced: boolean;
  /** The customer's first open of the signing link (never a colleague's). */
  openedAt: Date | null;
  signedAt: Date | null;
  declinedAt: Date | null;
  declineReason: string | null;
  changeRequestedAt: Date | null;
  changeRequestNote: string | null;
  invoicedAt: Date | null;
  depositPaidAt: Date | null;
  deliveryScheduledFor: Date | null;
  deliveredAt: Date | null;
};

export type StuckInput = {
  now: Date;
  leadId: string;
  /** open | nurture | won (a lost deal is closed, not stuck — the lookup says so instead). */
  status: string;
  createdAt: Date;
  /** Nurture: `reason` is the stored code (leadNurture.NURTURE_REASONS), `interest` what they may still want. */
  parked?: { since: Date | null; reason: string | null; interest?: string | null; reviewAt: Date | null } | null;
  /** The deal's attention signals (open deals only — the Attention Centre lists nothing else). */
  signals: Pick<AttentionSignal, "kind" | "key" | "detail" | "since" | "actionHref">[];
  /** Signal key → how it was set aside, while that is in force (setAsideNotes). */
  setAside: ReadonlyMap<string, string>;
  /** The deal's latest live quote, if the person may see it. */
  quote: StuckQuote | null;
  /** The deliveries board is on, so a quote's invoice, deposit and delivery dates are kept. */
  deliveries: boolean;
  lastIn: { at: Date; channel: string } | null;
  lastOut: { at: Date; channel: string } | null;
  /** The last real contact either way — customerContact.ts's rule. */
  lastContactAt: Date | null;
};

const day = (d: Date) => johannesburgDateKey(d);
const clip = (s: string | null | undefined, n: number) => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : null);
const quoted = (s: string | null | undefined) => (clip(s?.trim(), 140) ? `: "${clip(s!.trim(), 140)}"` : "");

/** Most pressing kind first; within a kind, the one that has waited longest. */
export function rankStuckReasons(reasons: readonly StuckReason[]): StuckReason[] {
  const at = (r: StuckReason) => r.date?.getTime() ?? Number.MAX_SAFE_INTEGER;
  return [...reasons].sort((a, b) => STUCK_ORDER.indexOf(a.kind) - STUCK_ORDER.indexOf(b.kind) || at(a) - at(b));
}

/** Who is waiting on whom, from the last message each way. */
export function waitingOn(lastIn: { at: Date } | null, lastOut: { at: Date } | null): "us" | "customer" | null {
  if (lastIn && (!lastOut || lastIn.at.getTime() > lastOut.at.getTime())) return "us";
  return lastOut ? "customer" : null;
}

/** A signed quote's next step on the deliveries board, while it is not done or booked ahead. */
function afterSigning(q: StuckQuote, now: Date): StuckReason | null {
  const n = `Q-${q.number}`;
  const link = `/quotes/${q.id}`;
  const todayStart = new Date(`${day(now)}T00:00:00+02:00`);
  switch (deliveryStage({ ...q, customer: "" }, todayStart)) {
    case "to_invoice":
      return { kind: "after_signing", why: `${n} was signed${q.signedAt ? ` on ${day(q.signedAt)}` : ""} but hasn't been invoiced yet`, date: q.signedAt, link };
    case "awaiting_deposit":
      return { kind: "after_signing", why: `${n} was invoiced on ${day(q.invoicedAt!)} and the deposit hasn't been marked paid`, date: q.invoicedAt, link };
    case "to_schedule":
      return { kind: "after_signing", why: `The deposit on ${n} was paid on ${day(q.depositPaidAt!)} but delivery hasn't been booked`, date: q.depositPaidAt, link };
    case "overdue":
      return { kind: "after_signing", why: `Delivery of ${n} was booked for ${day(q.deliveryScheduledFor!)} and hasn't been marked delivered`, date: q.deliveryScheduledFor, link };
    default:
      return null;
  }
}

/** Every reason the records give, ranked. */
export function stuckReasons(input: StuckInput): StuckReason[] {
  const { now, quote: q } = input;
  const lead = `/leads/${input.leadId}`;
  const reasons: StuckReason[] = [];

  if (input.status === "nurture") {
    const p = input.parked;
    reasons.push({
      kind: "parked",
      why: `Parked in nurture${p?.since ? ` on ${day(p.since)}` : ""}${p?.reason ? quoted(nurtureReasonLabel(p.reason)) : ""}${p?.interest?.trim() ? ` (interest: ${clip(p.interest.trim(), 100)})` : ""}${p?.reviewAt ? ` — review due ${day(p.reviewAt)}` : ""}`,
      date: p?.since ?? null,
      link: lead,
    });
  }

  for (const s of input.signals) {
    const setAside = input.setAside.get(s.key);
    reasons.push({ kind: FROM_SIGNAL[s.kind], why: s.detail, date: s.since ? new Date(s.since) : null, link: s.actionHref, ...(setAside ? { setAside } : {}) });
  }

  if (q) {
    const n = `Q-${q.number}`;
    const link = `/quotes/${q.id}`;
    // Still in play: not signed and not withdrawn. A revision replaces a quote, so the latest live one is current.
    const live = !q.signedAt && q.status !== "cancelled" && q.status !== "accepted";
    if (live && q.changeRequestedAt) {
      reasons.push({ kind: "changes_requested", why: `The customer asked for changes to ${n}${quoted(q.changeRequestNote)} — no revised quote since`, date: q.changeRequestedAt, link });
    }
    if (live && q.declinedAt) {
      reasons.push({ kind: "quote_declined", why: `The customer declined ${n}${quoted(q.declineReason)}`, date: q.declinedAt, link });
    }
    if (live && !q.declinedAt && !q.openedAt && q.emailBounced) {
      reasons.push({ kind: "quote_bounced", why: `The email carrying ${n} bounced — the customer's mail server refused it, so they never got it`, date: q.sentAt, link });
    } else if (live && !q.declinedAt && q.sentAt && !q.openedAt && q.emailOpen !== "opened") {
      const days = calendarDaysAgo(q.sentAt, now);
      // Opening is seen only on a signing link. A quote that went out only as an emailed PDF can have been read
      // without a trace — all there is, is its email's open tracking, which is never proof it went unread.
      const why = q.viaLink
        ? `${n} went out ${agoPhrase(days)} (${day(q.sentAt)}) and the customer hasn't opened it`
        : q.emailOpen === "not_detected"
          ? `${n} was emailed ${agoPhrase(days)} (${day(q.sentAt)}) and no open of that email has been detected`
          : null;
      if (why && days >= QUOTE_UNOPENED_DAYS) reasons.push({ kind: "quote_unopened", why, date: q.sentAt, link });
    }
    if (input.deliveries && q.status === "accepted") {
      const next = afterSigning(q, now);
      if (next) reasons.push(next);
    }
  }

  // Quiet is the CUSTOMER's silence — never when they wrote last and are waiting on us (the Today queue's rule too).
  // Only on an open deal: a won one's customer going quiet holds nothing up, and a parked one is quiet on purpose.
  if (input.status === "open" && waitingOn(input.lastIn, input.lastOut) !== "us") {
    if (input.lastContactAt) {
      const days = calendarDaysAgo(input.lastContactAt, now);
      if (days >= NO_CONTACT_DAYS) {
        const ours = input.lastOut && input.lastOut.at.getTime() >= input.lastContactAt.getTime() ? input.lastOut : null;
        reasons.push({
          kind: "customer_quiet",
          why: ours ? `Our last message (${ours.channel}, ${day(ours.at)}) has had no reply — no contact for ${days} days` : `No contact with the customer for ${days} days`,
          date: input.lastContactAt,
          link: lead,
        });
      }
    } else if (calendarDaysAgo(input.createdAt, now) > NEW_LEAD_DAYS) {
      reasons.push({ kind: "customer_quiet", why: `No message, call or meeting with the customer is logged on this deal (added ${agoPhrase(calendarDaysAgo(input.createdAt, now))})`, date: null, link: lead });
    }
  }

  return rankStuckReasons(reasons);
}

/**
 * Signal key → how someone set that warning aside, while it is in force: "snoozed until 2026-11-19: "In Italy"".
 * Read with the Attention Centre's own parser, so a set-aside it ignores is ignored here too.
 */
export function setAsideNotes(raw: unknown, now: Date): Map<string, string> {
  const notes = new Map<string, string>();
  for (const [key, row] of Object.entries(parseAttentionDispositions(raw))) {
    if (!dispositionIsActive(row, now)) continue;
    const at = dispositionAt(row)!;
    notes.set(key, `${row.state === "dismissed" ? `dismissed on ${day(at)}` : `snoozed until ${day(at)}`}${quoted(row.reason)}`);
  }
  return notes;
}

/** Days in the stage — the same count the stage-age signal makes — against the stage's own limit, or that it has none. */
export function stageFacts(stage: { name: string; staleAfterDays: number | null }, enteredAt: Date, now: Date) {
  const days = Math.floor((now.getTime() - enteredAt.getTime()) / 86_400_000);
  const limit = stage.staleAfterDays && stage.staleAfterDays > 0 ? stage.staleAfterDays : null;
  return {
    name: stage.name,
    since: day(enteredAt),
    days,
    ...(limit ? { limitDays: limit, overTheLimit: days >= limit } : { limit: "none — this stage has no time limit set, so time in it is never flagged" }),
  };
}

/** The last word each way, and who is waiting on whom. */
export function conversationFacts(lastIn: { at: Date; channel: string } | null, lastOut: { at: Date; channel: string } | null, lastContactAt: Date | null, now: Date) {
  const who = waitingOn(lastIn, lastOut);
  return {
    lastFromCustomer: lastIn ? { when: stamp(lastIn.at), channel: lastIn.channel } : "none recorded",
    lastFromUs: lastOut ? { when: stamp(lastOut.at), channel: lastOut.channel } : "none recorded",
    waitingOn: who === "us" ? "us — the customer wrote last" : who === "customer" ? "the customer — we wrote last" : "nobody — no messages either way",
    lastContact: lastContactAt ? `${stamp(lastContactAt)} (${agoPhrase(calendarDaysAgo(lastContactAt, now))})` : "none recorded",
  };
}

/** Sent with the reasons, so the rule sits next to the data it governs (as WHY_LEGEND does). */
export const STUCK_LEGEND =
  "`reasons` are worked out by fixed rules from the dated records linked with them, MOST PRESSING FIRST: parked in nurture, the customer waiting on our reply, changes they asked for, a quote they declined, an overdue follow-up, a step after signing (invoice, deposit, delivery), a quote whose email bounced, a quote they never opened, a quote running out, too long in the stage, no next step, and last the customer going quiet. " +
  "Give them in that order, each with its date and its link. They are the ONLY reasons you may state as fact; the facts after them (stage, conversation, quote, nextStep) are records too and may be given with their dates. Anything else you think is behind it (price, a competitor, finance, timing) is a guess: start it with \"My read:\". " +
  "`setAside`: someone snoozed or dismissed that warning, with the reason they gave — say so. `financeMentions` are messages and notes on the deal that mention finance: evidence to read, not a reason on their own. " +
  "No reasons: say the records show nothing holding it up, then what the facts do show.";
