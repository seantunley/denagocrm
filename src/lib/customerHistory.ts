/**
 * Which audit entries a customer's page may show to the person looking.
 *
 * A customer's history is theirs and their deals'. But a person may be allowed
 * to open the customer and NOT one of their deals (a colleague's), and an audit
 * entry about a deal very often names the customer as well. So neither "this
 * deal is the customer's" nor "this entry names the customer" is a reason to
 * show it. An entry is shown when it is about:
 *
 *   - the customer and no deal; or
 *   - a deal of theirs that the viewer may open.
 *
 * Found in review of #874 (2026-10-12): the page took every deal of the
 * customer, and every entry naming the customer, so a restricted deal's audit
 * trail was readable from its customer's page.
 *
 * Pure: where-clauses and id lists, so it can be tested without a database.
 */

/**
 * The customer's deals the viewer may open. `accessible` is what
 * getAccessibleLeadIds returns: null = unrestricted, a list = exactly those —
 * and an EMPTY list means none, never "no filter".
 */
export function viewableDealIds(customerDealIds: readonly string[], accessible: readonly string[] | null): string[] {
  if (accessible === null) return [...customerDealIds];
  const allowed = new Set(accessible);
  return customerDealIds.filter((id) => allowed.has(id));
}

export function customerHistoryWhere(contactId: string, dealIds: readonly string[]) {
  return { OR: [{ contactId, leadId: null }, ...(dealIds.length > 0 ? [{ leadId: { in: [...dealIds] } }] : [])] };
}
