/**
 * Which record governs access to a signature request.
 *
 * Its own module, with NO server imports, for two reasons: the precedence rule
 * is the security-critical part and has to be unit-testable on its own, and
 * `access.ts` reaches the permission stack, which pulls in `server-only` and
 * cannot be loaded from a test at all.
 */

import { DELIVERY_NOTE } from "./subject";

export type RequestBinding = {
  quoteId: string | null;
  jobCardId: string | null;
  contactId: string | null;
  documentId: string | null;
  createdById: string | null;
  /** A delivery note names its QUOTE here (subject.ts), not in quoteId — and that quote governs it. */
  subjectType: string | null;
  subjectId: string | null;
};

/** The quote a delivery note is about, or null for any other request. */
const deliveryNoteQuote = (r: RequestBinding) => (r.subjectType === DELIVERY_NOTE && r.subjectId ? r.subjectId : null);

export type GoverningBinding =
  | { kind: "quote"; id: string }
  | { kind: "jobcard"; id: string }
  | { kind: "document"; id: string }
  | { kind: "contact"; id: string };

/**
 * The ONE binding that decides access, by precedence — NOT "any binding the
 * caller happens to be able to reach".
 *
 * That distinction is the whole point. Most requests carry several bindings at
 * once (the one in production carries a quote, a contact and a document), so a
 * rule that allows when ANY of them is reachable lets a role holding
 * signing.manage plus documents.view_all — or merely access to the customer —
 * act on a request for a quote it cannot open.
 *
 * Quote and job card are authoritative: the document is GENERATED from one of
 * them and the contact is merely its customer, so neither is evidence of access
 * to the underlying deal.
 */
export function governingBinding(request: RequestBinding): GoverningBinding | null {
  // Sean 2026-11-14: a rep must not see the delivery note on another rep's deal — its quote is in subjectId. It
  // carries the customer and the generated document too, so without this its customer's visibility decided it.
  const quote = request.quoteId ?? deliveryNoteQuote(request);
  if (quote) return { kind: "quote", id: quote };
  if (request.jobCardId) return { kind: "jobcard", id: request.jobCardId };
  if (request.documentId) return { kind: "document", id: request.documentId };
  if (request.contactId) return { kind: "contact", id: request.contactId };
  return null;
}

/** The records of each kind a user may open. `null` is "every one of that kind", as the permission scopes report it. */
export type AccessibleRecordIds = {
  quoteIds: string[] | null;
  jobCardIds: string[] | null;
  documentIds: string[] | null;
  contactIds: string[] | null;
  userId: string;
};

/**
 * The same decision as {@link governingBinding}, as a LIST filter: the requests
 * whose governing record this user may open.
 *
 * Each branch names the bindings ABOVE it as null, which is what makes it the
 * same rule and not a looser one. Without those nulls this would read "a quote
 * you can open, OR a contact you can open" — and a request for somebody else's
 * quote would appear in the list of anyone who can see its customer, the exact
 * escalation the precedence exists to stop.
 *
 * A request bound to nothing is its creator's.
 */
export function accessibleRequestWhere(ids: AccessibleRecordIds) {
  // "Bound to one of this kind, and it is one they may open."
  const among = (list: string[] | null) => (list === null ? { not: null } : { in: list });
  // "Not a delivery note with a quote", NULLs named: a NOT over the nullable column would also drop every request
  // with no subject at all.
  const notNote = { OR: [{ subjectType: null }, { subjectType: { not: DELIVERY_NOTE } }, { subjectId: null }] };
  return {
    OR: [
      { quoteId: among(ids.quoteIds) },
      { quoteId: null, subjectType: DELIVERY_NOTE, subjectId: among(ids.quoteIds) },
      { quoteId: null, ...notNote, jobCardId: among(ids.jobCardIds) },
      { quoteId: null, ...notNote, jobCardId: null, documentId: among(ids.documentIds) },
      { quoteId: null, ...notNote, jobCardId: null, documentId: null, contactId: among(ids.contactIds) },
      { quoteId: null, ...notNote, jobCardId: null, documentId: null, contactId: null, createdById: ids.userId },
    ],
  };
}
