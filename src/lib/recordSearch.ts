/**
 * The shape and the limits of a record search, in a module BOTH sides can import.
 *
 * WHY THIS FILE EXISTS. A `"use server"` module may only export async functions —
 * everything else in it becomes a client-callable endpoint, so Next refuses the
 * file outright. `MIN_SEARCH_TERM` lived beside the action, which typechecked
 * perfectly and then failed the production build:
 *
 *   ./src/app/actions/search.ts:61:1
 *   Only async functions are allowed to be exported in a "use server" file.
 *
 * A shared constant between a Server Action and its client therefore needs a home
 * outside the action. Types are erased and would have been fine either way; the
 * constant is the real reason.
 */

export type SearchHitType =
  | "contact" | "lead" | "quote" | "vehicle" | "jobcard"
  | "case" | "message" | "activity" | "document" | "product" | "knowledge";

export type SearchHit = {
  id: string;
  /** What the row is, for the group heading and the icon. */
  type: SearchHitType;
  label: string;
  sublabel: string;
  href: string;
  /** The words around the match, for a message, note, activity or knowledge answer. */
  snippet?: string;
  /** A file: opens in a new tab. */
  newTab?: boolean;
};

/**
 * Below this a search is mostly noise, and every keystroke is a round trip.
 *
 * Shared so the palette does not ask for a search the server will refuse, and the
 * server does not trust the palette to have asked sensibly. Both check it.
 */
export const MIN_SEARCH_TERM = 2;

/** Per type. The palette is a shortlist; /search is the list. */
export const SEARCH_HITS_PER_TYPE = 5;

/** Group headings, in the order the palette renders them. */
export const SEARCH_GROUPS: ReadonlyArray<{ type: SearchHitType; heading: string }> = [
  { type: "contact", heading: "Customers" },
  { type: "lead", heading: "Leads" },
  { type: "quote", heading: "Quotes" },
  { type: "vehicle", heading: "Vehicles" },
  { type: "jobcard", heading: "Job cards" },
  { type: "message", heading: "Messages & notes" },
];

/**
 * May this person see a message (lib/crmSearch.ts)? On a deal: only with access to THAT deal — its customer is not
 * enough, since a customer's deals can belong to different people. On no deal: by its customer. Neither: no.
 * `null` is "every one of that kind"; [] is none.
 */
export function messageVisible(
  row: { leadId: string | null; contactId: string | null },
  leadIds: readonly string[] | null,
  contactIds: readonly string[] | null,
): boolean {
  if (row.leadId) return leadIds === null || leadIds.includes(row.leadId);
  if (row.contactId) return contactIds === null || contactIds.includes(row.contactId);
  return false;
}

/** Every kind /search lists, in order. */
export const ALL_SEARCH_GROUPS: ReadonlyArray<{ type: SearchHitType; heading: string }> = [
  ...SEARCH_GROUPS,
  { type: "case", heading: "Customer cases" },
  { type: "activity", heading: "Activities" },
  { type: "document", heading: "Documents" },
  { type: "product", heading: "Products" },
  { type: "knowledge", heading: "Approved answers (chatbot knowledge)" },
];
