/**
 * ONE TIMELINE (Sean, 2026-10-12: "Quote timeline in one place and email
 * timeline in another… surely everything must be in one place?").
 *
 * A CUSTOMER is the person or company; a LEAD is one deal with them. Each
 * timeline entry (a Communication, an Activity) is filed on a lead, on a
 * customer, or on both — and each page used to show only the rows filed on
 * ITSELF. So an email written from the customer's page was invisible on their
 * deal, and a call logged on the deal was invisible on the customer. The
 * history was all there and nobody could see it in one place.
 *
 * The rule, for every screen and for the assistant:
 *
 *   the CUSTOMER's timeline  = everything filed on the customer
 *                            + everything filed on any of their deals;
 *   a DEAL's timeline        = everything filed on that deal
 *                            + what is filed on its customer and on NO deal.
 *
 * Another deal's entries stay off a deal's timeline: they are that deal's.
 *
 * These are where-clauses, not queries, so each caller keeps its own client,
 * ordering and access rules. Pure, and safe to import anywhere.
 */

/** A deal's timeline. `contactId` null (or one the viewer may not open): the deal's own rows only. */
export function dealTimelineWhere(deal: { id: string; contactId: string | null }) {
  return { OR: [{ leadId: deal.id }, ...(deal.contactId ? [{ contactId: deal.contactId, leadId: null }] : [])] };
}

/** A customer's timeline. `dealIds`: their deals the VIEWER may open — a deal they cannot open contributes nothing. */
export function customerTimelineWhere(contactId: string, dealIds: readonly string[]) {
  return { OR: [{ contactId }, ...(dealIds.length > 0 ? [{ leadId: { in: [...dealIds] } }] : [])] };
}

/** The form value for "this is about the customer, not one deal". */
export const NO_DEAL = "general";

export type DealOption = { id: string; label: string };

/**
 * When something is written from the CUSTOMER's page, which deal is it about?
 *
 *   no open deal        → none: it is filed on the customer;
 *   exactly one         → that one, without asking;
 *   more than one       → ASK (Sean: "it must ask. But only if there is more
 *                         than one deal").
 */
export function dealChoice(openDeals: readonly DealOption[]): { ask: false; leadId: string | null } | { ask: true; options: DealOption[] } {
  if (openDeals.length === 0) return { ask: false, leadId: null };
  if (openDeals.length === 1) return { ask: false, leadId: openDeals[0].id };
  return { ask: true, options: [...openDeals] };
}

/** What a form posted for the deal: an id, or null for none / "the customer in general". */
export function postedDealId(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  return value && value !== NO_DEAL ? value : null;
}

/**
 * Where a new entry is filed, given what the form said and what the deal's own
 * record says. An entry on a deal ALSO carries that deal's customer, so it is
 * never stranded on one side again.
 *
 *  - a deal and no customer        → the deal's customer is added;
 *  - a deal and ITS customer       → both, as given;
 *  - a deal and a DIFFERENT customer → refused: one of the two is wrong, and
 *                                     filing it on both would put one customer's
 *                                     message on another's record.
 */
export function filedOn(
  posted: { leadId: string | null; contactId: string | null },
  /** The deal's customer as the database has it; `undefined` when no deal was posted. */
  dealCustomerId: string | null | undefined,
): { ok: true; leadId: string | null; contactId: string | null } | { ok: false; error: string } {
  if (!posted.leadId) return { ok: true, leadId: null, contactId: posted.contactId };
  if (posted.contactId && dealCustomerId && posted.contactId !== dealCustomerId) {
    return { ok: false, error: "That deal belongs to a different customer." };
  }
  if (posted.contactId && !dealCustomerId) {
    // The deal has no customer linked: naming one here would link them by the back door.
    return { ok: false, error: "That deal isn't linked to this customer." };
  }
  return { ok: true, leadId: posted.leadId, contactId: dealCustomerId ?? null };
}
