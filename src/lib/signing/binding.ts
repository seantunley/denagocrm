/**
 * Which record governs access to a signature request.
 *
 * Its own module, with NO server imports, for two reasons: the precedence rule
 * is the security-critical part and has to be unit-testable on its own, and
 * `access.ts` reaches the permission stack, which pulls in `server-only` and
 * cannot be loaded from a test at all.
 */

export type RequestBinding = {
  quoteId: string | null;
  jobCardId: string | null;
  contactId: string | null;
  documentId: string | null;
  createdById: string | null;
};

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
  if (request.quoteId) return { kind: "quote", id: request.quoteId };
  if (request.jobCardId) return { kind: "jobcard", id: request.jobCardId };
  if (request.documentId) return { kind: "document", id: request.documentId };
  if (request.contactId) return { kind: "contact", id: request.contactId };
  return null;
}
