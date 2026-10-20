/**
 * What counts as being IN TOUCH with a customer — one definition, so "gone
 * quiet", "not contacted in 7 days" and "oldest contact first" mean the same
 * thing wherever they're asked.
 *
 * Contact is a message either way, a call, a meeting, a visit. It is NOT
 * something the business wrote for itself: an internal note on the timeline
 * (Communication type "note" — the composer's note, a debrief's summary, the
 * assistant's notes), a completed to-do, or blocked-out staff time. Counting
 * those made a lead someone had merely annotated look freshly contacted, and
 * hid it from "who's gone quiet".
 */

/** Timeline entries the business wrote for itself — never contact. */
export const INTERNAL_COMMUNICATION_TYPES = ["note"] as const;
/** Completed activities that aren't contact with the customer. */
export const NON_CONTACT_ACTIVITY_TYPES = ["todo"] as const;

/**
 * "What was this?" on the note box (Sean, 2026-10-18): a note that records a call, a WhatsApp or a visit IS contact,
 * so it is saved as that type and counts; "Internal note" stays a note and doesn't. The default is the note.
 */
export const NOTE_KINDS = [
  { value: "note", label: "Internal note (not contact)" },
  { value: "call", label: "Phone call" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "meeting", label: "In person" },
] as const;

/** Every type a person may LOG by hand — the note box and "Log a call" together. Anything else is refused. */
export const LOGGABLE_COMMUNICATION_TYPES = ["note", "call", "email", "whatsapp", "meeting"] as const;

/** Prisma filter: communications that are real contact. */
export const contactCommunicationWhere = { type: { notIn: [...INTERNAL_COMMUNICATION_TYPES] } };

/** Prisma filter: completed activities that are real contact. */
export const contactActivityWhere = {
  status: "done",
  availabilityBlock: false,
  type: { notIn: [...NON_CONTACT_ACTIVITY_TYPES] },
};

/** For one record already loaded: is this entry contact with the customer? */
export function isCustomerContact(entry: { type: string }, kind: "communication" | "activity"): boolean {
  const internal: readonly string[] = kind === "communication" ? INTERNAL_COMMUNICATION_TYPES : NON_CONTACT_ACTIVITY_TYPES;
  return !internal.includes(entry.type);
}

/**
 * The last real contact from a lead's timeline: the newest communication or
 * completed activity that IS contact. A newer internal note never replaces an
 * older call. (The queries already filter with the where-clauses above; this
 * applies the same rule to whatever rows come back, so the answer can't drift
 * if a query changes.)
 */
export function latestContactAt(
  communications: { type: string; occurredAt: Date }[],
  activities: { type: string; doneAt: Date | null; availabilityBlock?: boolean }[],
): Date | null {
  const times = [
    ...communications.filter((c) => isCustomerContact(c, "communication")).map((c) => c.occurredAt),
    ...activities.filter((a) => !a.availabilityBlock && isCustomerContact(a, "activity")).map((a) => a.doneAt),
  ].filter((d): d is Date => d instanceof Date);
  return times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : null;
}
