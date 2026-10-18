/**
 * PROACTIVE DAX — the rules, with no database (Sean, 2026-10-18: "I want DAX to
 * function like OpenClaw and Hermes, proactive"; plan: docs/proactive-dax-plan-2026-10-18.md).
 *
 * Part 1 is "can't wait" CUSTOMER ACTIVITY: the moment a customer acts, the
 * person responsible for them hears about it — in the CRM, as a phone
 * notification, and on their linked WhatsApp. These are words built here, not
 * written by the model: instant, and free.
 *
 * Who decides it is on: the OWNER's switch for the workspace, then each
 * person's OWN switch — both default OFF. Nothing here ever reaches a customer.
 */

import { nextRun, snapToHalfHour } from "./assistantSchedule";

/**
 * The same quiet hours as customer messaging (communicationPolicy.ts — 20:00 to 08:00 Johannesburg), kept here
 * so these rules stay free of the database. South Africa has no daylight saving: UTC+2 all year.
 */
const SA_OFFSET_MS = 2 * 60 * 60 * 1000;
const saHour = (at: Date) => new Date(at.getTime() + SA_OFFSET_MS).getUTCHours();
export const isQuietHour = (at: Date) => saHour(at) >= 20 || saHour(at) < 8;
/** 08:00 Johannesburg on or after `at`. */
export function nextMorning(at: Date): Date {
  const sa = new Date(at.getTime() + SA_OFFSET_MS);
  const eight = Date.UTC(sa.getUTCFullYear(), sa.getUTCMonth(), sa.getUTCDate(), 6, 0, 0);
  return new Date(eight >= at.getTime() ? eight : eight + 24 * 60 * 60 * 1000);
}

/** The owner's switch: proactive DAX in this workspace at all. "on" | "off"; unset = off. */
export const ASSISTANT_PROACTIVE_KEY = "ASSISTANT_PROACTIVE";
/** Each person's own switch, one setting per person: "on" | "off"; unset = off. */
export const proactivePersonKey = (userId: string) => `ASSISTANT_PROACTIVE_FOR:${userId}`;
export const proactiveOn = (stored: string | null | undefined) => stored === "on";

/** The AssistantTurn source these arrive as (in PROACTIVE_SOURCES: the red dot, push, WhatsApp). */
export const PROACTIVE_SOURCE = "proactive";
/** What the conversation shows as the "question" of an alert. */
export const PROACTIVE_QUESTION = "Customer activity";

export const PROACTIVE_KINDS = ["quote_opened", "quote_revisited", "customer_waiting", "quote_signed", "service_booked"] as const;
export type ProactiveKind = (typeof PROACTIVE_KINDS)[number];

/** A customer back at the same quote this many times is worth a call. */
export const REVISIT_ALERT_AT = 3;
/** A customer's message with no answer from anyone for this long, in work hours. */
export const WAITING_AFTER_MS = 15 * 60 * 1000;
/** …and no older than this: a message from last week is the inbox's business, not an alert. */
export const WAITING_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** At most this many alerts reach a person in a day; past it they wait for the morning. */
export const DAILY_ALERT_CEILING = 12;

export type ProactiveEvent = {
  kind: ProactiveKind;
  /** The customer as staff know them. */
  customer: string;
  /** Path of the record in the CRM. */
  url: string;
  /** What the event is about, for the words: "Q-1032", the channel, when the booking is. */
  detail?: string;
  /** For customer_waiting: the start of what they wrote. */
  snippet?: string;
  /** For customer_waiting: how long ago they wrote. */
  minutesAgo?: number;
  /**
   * What makes this event the SAME event if it is reported twice — the quote, the message, the booking. With the
   * person and the kind it is unique in the database, so a reload, a retry or a second worker never alerts twice.
   */
  recordKey: string;
};

/** The words of an alert. Short — it is read on a lock screen — and always with the way to the record. */
export function proactiveText(event: ProactiveEvent, origin: string): string {
  const who = event.customer.trim() || "A customer";
  const link = `${origin.replace(/\/$/, "")}${event.url}`;
  const line = (() => {
    switch (event.kind) {
      case "quote_opened":
        return `👀 ${who} just opened quote ${event.detail ?? ""}.`.replace(" .", ".");
      case "quote_revisited":
        return `🔁 ${who} has opened ${event.detail ?? "their quote"} ${REVISIT_ALERT_AT} times and hasn't signed. A good moment to call.`;
      case "customer_waiting": {
        const ago = event.minutesAgo && event.minutesAgo > 0 ? ` ${event.minutesAgo} min ago` : "";
        const said = event.snippet ? `: “${clip(event.snippet, 120)}”` : ".";
        return `💬 ${who} wrote on ${event.detail ?? "a channel"}${ago} and no one has answered yet${said}`;
      }
      case "quote_signed":
        return `✅ ${who} signed ${event.detail ?? "their quote"}.`;
      case "service_booked":
        return `📅 New service booking from ${who}${event.detail ? ` for ${event.detail}` : ""}.`;
    }
  })();
  return `${line}\n${link}`;
}

/** The phone notification: names nothing beyond the kind — a lock screen is not private. */
export function proactivePush(kind: ProactiveKind): string {
  switch (kind) {
    case "quote_opened":
      return "A customer is looking at a quote";
    case "quote_revisited":
      return "A customer keeps coming back to a quote";
    case "customer_waiting":
      return "A customer is waiting for an answer";
    case "quote_signed":
      return "A customer signed a quote";
    case "service_booked":
      return "A new service booking";
  }
}

/**
 * When an alert goes: now, or held for the morning. Between 20:00 and 08:00 (Johannesburg) it waits for 08:00 —
 * nobody is buzzed at night — and so does anything past the day's ceiling. Returns null for "now".
 */
export function proactiveDeliverAt(now: Date, alreadyToday: number): Date | null {
  if (isQuietHour(now)) return nextMorning(now);
  // Past the ceiling: tomorrow morning (08:00 after tonight's 20:00).
  if (alreadyToday >= DAILY_ALERT_CEILING) return nextMorning(new Date(johannesburgDayStart(now).getTime() + 20 * 60 * 60 * 1000));
  return null;
}

/** The start of today in Johannesburg, as an instant — "alerts so far today" counts from here. */
export function johannesburgDayStart(now: Date): Date {
  const sa = new Date(now.getTime() + SA_OFFSET_MS);
  return new Date(Date.UTC(sa.getUTCFullYear(), sa.getUTCMonth(), sa.getUTCDate(), -2, 0, 0));
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/*
 * PART 2 — THE MORNING BRIEF. Each workday at the person's chosen time DAX writes "your day": what is on, what
 * their customers did since yesterday (including alerts held overnight, folded in rather than sent one by one), and
 * the three things that matter most. One model call per person per workday.
 */
/** Each person's brief time, "HH:MM" Johannesburg, or "off". Unset = the default. */
export const briefPersonKey = (userId: string) => `ASSISTANT_BRIEF_AT:${userId}`;
export const BRIEF_DEFAULT = "07:30";
/** The times offered: the half hours from 06:00 to 10:00 — when the half-hourly job wakes. */
export const BRIEF_TIMES = Array.from({ length: 9 }, (_, i) => `${String(6 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);
/** A brief not written by this hour is not a MORNING brief any more: skipped for the day. */
export const BRIEF_LATEST_HOUR = 11;
/** Held kind, one row per person per day: the claim that makes the brief happen once. */
export const BRIEF_KIND = "morning_brief";
export const BRIEF_SOURCE = "brief";
export const BRIEF_QUESTION = "Your morning brief";
/**
 * How long a claim on a brief holds before another worker may take it. Longer than the cron route can live
 * (maxDuration), so a lease only runs out once its worker is certainly gone — two briefs are never written side by side.
 */
export const BRIEF_LEASE_MS = 10 * 60 * 1000;
/** Part 3: the answer to a check-back DAX set itself (lib/proactiveFollowUp.ts), as the conversation labels it. */
export const FOLLOW_UP_SOURCE = "followup";
const CHECK_BACK_MIN_AHEAD_MS = 60 * 60 * 1000;
const CHECK_BACK_MAX_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * When a check-back asked for at `when` ("YYYY-MM-DDTHH:MM", SA time) would really run — snapped to the half hour
 * the runner wakes on — or why it can't: at least an hour away and within 30 days.
 */
export function checkBackTiming(when: string, now: Date): { onDate: string; timeOfDay: string; at: Date } | { refused: string } {
  const [onDate, time] = when.split("T");
  const timeOfDay = snapToHalfHour(time ?? "");
  const at = nextRun({ cadence: "once", onDate, timeOfDay }, now);
  const ahead = at ? at.getTime() - now.getTime() : -1;
  if (!at || ahead < CHECK_BACK_MIN_AHEAD_MS || ahead > CHECK_BACK_MAX_AHEAD_MS) {
    return { refused: "the time has to be between an hour and 30 days from now" };
  }
  return { onDate, timeOfDay, at };
}

/**
 * The brief takes in every alert held for release up to 08:00 this morning — those raised overnight (held to 08:00)
 * and those past yesterday's ceiling — even when the brief is written before then (07:30 by default).
 */
export function briefHoldsUntil(now: Date): Date {
  return nextMorning(johannesburgDayStart(now));
}

/** The stored time, or the default; null when the person switched the brief off; anything unknown = the default. */
export function parseBriefAt(stored: string | null | undefined): string | null {
  if (stored === "off") return null;
  return stored && BRIEF_TIMES.includes(stored) ? stored : BRIEF_DEFAULT;
}

/** Johannesburg's date as "YYYY-MM-DD" — the brief's key for the day. */
export function johannesburgDateKey(now: Date): string {
  return new Date(now.getTime() + SA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Today's key when a brief at `at` is due now (a weekday, at or after its time, before BRIEF_LATEST_HOUR); else null. */
export function briefDueKey(now: Date, at: string): string | null {
  const sa = new Date(now.getTime() + SA_OFFSET_MS);
  const day = sa.getUTCDay();
  if (day === 0 || day === 6) return null;
  const [h, m] = at.split(":").map(Number);
  const minutes = sa.getUTCHours() * 60 + sa.getUTCMinutes();
  if (minutes < h * 60 + m || sa.getUTCHours() >= BRIEF_LATEST_HOUR) return null;
  return johannesburgDateKey(now);
}

/**
 * What DAX is asked. Alerts held overnight are given as facts (their words, without the links) so the brief
 * leads with them instead of them arriving one by one at 08:00.
 */
export function briefQuestion(now: Date, heldOvernight: readonly string[]): string {
  const day = new Intl.DateTimeFormat("en-ZA", { weekday: "long", day: "numeric", month: "long", timeZone: "Africa/Johannesburg" }).format(now);
  const overnight = heldOvernight
    .map((text) => text.split("\n")[0].trim())
    .filter(Boolean)
    .slice(0, 12);
  return [
    `My morning brief for today, ${day}. Short, in this order:`,
    "1. My day — my meetings, tasks and deliveries today (use the daily brief).",
    "2. What my customers did since yesterday — quotes opened or signed, messages still waiting for an answer.",
    ...(overnight.length ? [`   Since last night: ${overnight.join(" · ")}`] : []),
    "3. The three things that matter most today, each with one line on why.",
    "Only what is mine. No greeting, no sign-off.",
  ].join("\n");
}

/** Whose alert it is: the deal's owner, else the customer's owner, else whoever made it. Never a guess beyond that. */
export function responsiblePerson(input: { dealOwnerId?: string | null; customerOwnerId?: string | null; fallbackId?: string | null }): string | null {
  return input.dealOwnerId || input.customerOwnerId || input.fallbackId || null;
}
