/**
 * Board rules with no imports, so a test can EXECUTE them.
 *
 * KanbanBoard.tsx reaches server-only code transitively, so anything asserted
 * about it otherwise has to be pattern-matched against its source — which is how
 * the defects below survived: a global stale constant, and an owner filter keyed
 * on a display name, both perfectly visible in the file and neither wrong in a
 * way a regex would notice.
 */

/**
 * Fallback only. Each stage carries its own `staleAfterDays`, configured in
 * Settings → Pipelines, and that is what decides health — a three-day
 * Qualification and a thirty-day Negotiation are not the same board.
 */
export const DEFAULT_STALE_DAYS = 7;

/** Whether a card has sat too long, by ITS OWN stage's rule. */
export function isStale(ageDays: number | null | undefined, staleAfterDays: number | null): boolean {
  return (ageDays ?? 0) >= (staleAfterDays ?? DEFAULT_STALE_DAYS);
}

/** Owner-filter sentinels. Real values are user IDs, never display names. */
export const OWNER_ANY = "";
export const OWNER_UNASSIGNED = "__unassigned";

/**
 * Whether a card passes the owner filter.
 *
 * The filter used to hold a display NAME and compare `lead.assignee === owner`.
 * Names are labels: two people called "J. Smith" become one entry that matches
 * both, and renaming somebody silently empties the filter for whoever had it
 * applied. An id is the identity.
 */
export function matchesOwnerFilter(assignedToId: string | null, owner: string): boolean {
  if (owner === OWNER_ANY) return true;
  if (owner === OWNER_UNASSIGNED) return !assignedToId;
  return assignedToId === owner;
}
