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

export type SearchHitType = "contact" | "lead" | "quote" | "vehicle" | "jobcard";

export type SearchHit = {
  id: string;
  /** What the row is, for the group heading and the icon. */
  type: SearchHitType;
  label: string;
  sublabel: string;
  href: string;
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
];
