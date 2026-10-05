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
