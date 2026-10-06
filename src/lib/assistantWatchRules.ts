import { z } from "zod";

/**
 * Watches — "tell me when Anna opens her quote". A condition the assistant cron
 * checks every tick with plain code (no ChatGPT), as the person who set it, and
 * tells ONLY that person: a note in their DAX thread and a push. A watch never
 * contacts a customer.
 *
 * This file is the pure part: what a valid watch is, how it reads, when a
 * record is news, and what the note says. No server-only imports, so the card,
 * the page and the tests can all use it.
 */

export const WATCH_KINDS = [
  "quote_viewed",
  "quote_unsigned",
  "lead_quiet",
  "test_drive_no_follow_up",
  "delivery_deposit_due",
] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];

/** Per person. Cheap to run, but each one can push — ten is plenty to keep track of. */
export const MAX_ACTIVE_WATCHES = 10;

/** Records named in one note; the rest are counted ("…and 3 more"). */
export const MAX_LISTED = 5;

/** Fires once and switches itself off: "tell me WHEN she opens it". */
export const ONE_SHOT_KINDS: readonly WatchKind[] = ["quote_viewed"];

/** The wait each kind uses when the person didn't name one. */
export const DEFAULT_HOURS: Partial<Record<WatchKind, number>> = {
  quote_unsigned: 48,
  test_drive_no_follow_up: 24,
  delivery_deposit_due: 48,
};
export const DEFAULT_DAYS: Partial<Record<WatchKind, number>> = { lead_quiet: 7 };

type Field = "leadId" | "quoteId" | "product" | "thresholdHours" | "thresholdDays";
/** Which fields each kind may carry — anything else is a mistake, not ignored. */
const ALLOWED: Record<WatchKind, readonly Field[]> = {
  quote_viewed: ["quoteId"],
  quote_unsigned: ["quoteId", "thresholdHours"],
  lead_quiet: ["leadId", "product", "thresholdDays"],
  test_drive_no_follow_up: ["thresholdHours"],
  delivery_deposit_due: ["thresholdHours"],
};
const REQUIRED: Partial<Record<WatchKind, Field>> = { quote_viewed: "quoteId" };

/**
 * The fields, unrefined — so the assistant's proposal union can reuse them
 * (a discriminated union needs plain objects). `watchInput` adds the rules that
 * tie them to the kind; everything that SAVES a watch goes through it.
 * quoteId may be the id or the number the person sees ("Q-1042").
 */
export const watchFields = {
  kind: z.enum(WATCH_KINDS),
  leadId: z.string().trim().min(1).max(64).optional(),
  quoteId: z.string().trim().min(1).max(64).optional(),
  product: z.string().trim().min(1).max(80).optional(),
  thresholdHours: z.number().int().min(1).max(24 * 30).optional(),
  thresholdDays: z.number().int().min(1).max(365).optional(),
};

export const watchInput = z
  .object(watchFields)
  .strict()
  .superRefine((w, ctx) => {
    const allowed = ALLOWED[w.kind];
    for (const field of ["leadId", "quoteId", "product", "thresholdHours", "thresholdDays"] as const) {
      if (w[field] !== undefined && !allowed.includes(field)) {
        ctx.addIssue({ code: "custom", path: [field], message: `A ${w.kind} watch doesn't take ${field}.` });
      }
    }
    const required = REQUIRED[w.kind];
    if (required && w[required] === undefined) {
      ctx.addIssue({ code: "custom", path: [required], message: `A ${w.kind} watch needs ${required}.` });
    }
    if (w.leadId !== undefined && w.product !== undefined) {
      ctx.addIssue({ code: "custom", path: ["product"], message: "Watch one lead, or leads for a product — not both." });
    }
  })
  // Defaults written in, so the saved row, the page and the label all say the real wait.
  .transform((w) => ({
    ...w,
    ...(DEFAULT_HOURS[w.kind] !== undefined ? { thresholdHours: w.thresholdHours ?? DEFAULT_HOURS[w.kind] } : {}),
    ...(DEFAULT_DAYS[w.kind] !== undefined ? { thresholdDays: w.thresholdDays ?? DEFAULT_DAYS[w.kind] } : {}),
  }));
export type WatchInput = z.infer<typeof watchInput>;

/** What describeWatch needs — a saved row (nulls) or a fresh input (undefined) both fit. */
export type WatchSpec = {
  kind: string;
  leadId?: string | null;
  quoteId?: string | null;
  product?: string | null;
  thresholdHours?: number | null;
  thresholdDays?: number | null;
};

/** "48 hours" reads better as "2 days". */
function span(hours: number): string {
  if (hours >= 48 && hours % 24 === 0) return `${hours / 24} days`;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * How it reads: "Tell me when Anna Jacobs opens Q-1042". Names come from the
 * record at the time it's set up; without them it still reads sensibly.
 */
export function describeWatch(w: WatchSpec, names: { quote?: string | null; customer?: string | null; lead?: string | null } = {}): string {
  const kind = w.kind as WatchKind;
  const hours = w.thresholdHours ?? DEFAULT_HOURS[kind] ?? 24;
  const days = w.thresholdDays ?? DEFAULT_DAYS[kind] ?? 7;
  const customer = names.customer ? safeName(names.customer) : null;
  const quote = names.quote ?? "the quote";
  switch (kind) {
    case "quote_viewed":
      return `Tell me when ${customer ?? "the customer"} opens ${quote}`;
    case "quote_unsigned":
      return w.quoteId
        ? `Tell me if ${quote}${customer ? ` (${customer})` : ""} is opened but not signed within ${span(hours)}`
        : `Tell me when any quote I can see is opened but not signed within ${span(hours)}`;
    case "lead_quiet":
      return w.leadId
        ? `Tell me if ${names.lead ? safeName(names.lead) : "this lead"} goes ${days} days without contact`
        : `Tell me when any open ${w.product ? `${w.product} ` : ""}lead I can see goes ${days} days without contact`;
    case "test_drive_no_follow_up":
      return `Tell me when a test drive finished over ${span(hours)} ago has no follow-up planned`;
    case "delivery_deposit_due":
      return `Tell me when a delivery is within ${span(hours)} and the deposit isn't paid`;
    default:
      return "Watch";
  }
}

/**
 * Which records are NEWS this tick, and the map to save.
 *
 * `fired` holds the records already told about while the condition still holds
 * ({ recordId: when }). A matching record not in it is news; one in it isn't
 * (no repeat every half hour). A record that stops matching drops out, so if
 * the condition comes back later — the lead goes quiet again — it is news again.
 * Anything unreadable in `previous` counts as empty.
 */
export function nextFiredState(
  previous: unknown,
  matchingIds: readonly string[],
  now: Date,
): { toNotify: string[]; fired: Record<string, string> } {
  const before = previous && typeof previous === "object" && !Array.isArray(previous) ? (previous as Record<string, unknown>) : {};
  const fired: Record<string, string> = {};
  const toNotify: string[] = [];
  for (const id of new Set(matchingIds)) {
    const at = before[id];
    if (typeof at === "string") fired[id] = at;
    else {
      fired[id] = now.toISOString();
      toNotify.push(id);
    }
  }
  return { toNotify, fired };
}

/** Same set of keys → nothing to write. */
export function firedChanged(previous: unknown, next: Record<string, string>): boolean {
  const before = previous && typeof previous === "object" && !Array.isArray(previous) ? Object.keys(previous) : [];
  const after = Object.keys(next);
  return before.length !== after.length || after.some((k) => !before.includes(k));
}

/**
 * A lead with no name is often saved under its phone number or email address —
 * that has no place in a notification. Anything that looks like one reads as
 * "a customer".
 */
export function safeName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes("@") || /\+?\d[\d\s()-]{6,}\d/.test(trimmed)) return "a customer";
  return trimmed;
}

/** Saved in the person's thread when a watch switches itself off because its record went away. */
export const WATCH_GONE_NOTE =
  "I've stopped this watch: the record it was watching is gone, or you can no longer open it. It's paused on the Ask page — delete it or ask me for a new one.";

/** One record in a note: "Q-1042" + "Anna Jacobs", with an optional detail. */
export type WatchHit = { ref: string; customer?: string | null; detail?: string | null };

const HEADINGS: Record<Exclude<WatchKind, "quote_viewed">, (w: WatchSpec) => string> = {
  quote_unsigned: (w) => `✍️ Opened but not signed after ${span(w.thresholdHours ?? 48)}:`,
  lead_quiet: (w) => `🤫 No contact for ${w.thresholdDays ?? 7} days or more:`,
  test_drive_no_follow_up: () => "🚗 Test drive done, no follow-up planned:",
  delivery_deposit_due: () => "💰 Delivery coming up, deposit not paid:",
};

/** The note saved in the person's thread: short, at most MAX_LISTED records named. */
export function watchNotification(w: WatchSpec, hits: readonly WatchHit[]): string {
  const line = (h: WatchHit) =>
    `• ${h.ref}${h.customer ? ` — ${safeName(h.customer)}` : ""}${h.detail ? ` (${h.detail})` : ""}`;
  if (w.kind === "quote_viewed") {
    const h = hits[0];
    return `👀 ${h?.customer ? safeName(h.customer) : "The customer"} opened ${h?.ref ?? "the quote"}.`;
  }
  const heading = HEADINGS[w.kind as Exclude<WatchKind, "quote_viewed">]?.(w) ?? "Something you're watching happened:";
  const more = hits.length > MAX_LISTED ? [`…and ${hits.length - MAX_LISTED} more.`] : [];
  return [heading, ...hits.slice(0, MAX_LISTED).map(line), ...more].join("\n");
}
