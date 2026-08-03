/**
 * Which record governs access to a document.
 *
 * Its own module, with NO server imports, for the same two reasons
 * `signing/binding.ts` is: the precedence rule is the security-critical part and
 * has to be unit-testable on its own, and `permissions.ts` reaches the whole
 * server stack (db, auth, `server-only`) and cannot be loaded from a test at all.
 *
 * This is the DOCUMENT half of the rule `signing/binding.ts` already states for
 * signature requests, and it is deliberately the same shape — one governing
 * record chosen by precedence, never "whichever link the caller happens to be
 * able to reach".
 */

/** The link columns on Document. Exactly the four the scope query selects. */
export type DocumentLinks = {
  quoteId: string | null;
  jobCardId: string | null;
  vehicleId: string | null;
  contactId: string | null;
};

export type GoverningDocumentLink =
  | { kind: "quote"; id: string }
  | { kind: "jobcard"; id: string }
  | { kind: "vehicle"; id: string }
  | { kind: "contact"; id: string };

/**
 * The ONE link that decides access, by precedence — NOT the union of every link
 * the document happens to carry.
 *
 * THE BUG. `getAccessibleDocumentIds` OR-ed the four links together, so a
 * document reachable through ANY of them was reachable. Nearly every
 * system-generated document carries a CONTACT link alongside its real subject:
 *
 *   fulfilment.ts   invoice / proof-of-payment / delivery-note / signature  → quote + contact
 *   studio.ts       finalised doc-instance PDF                              → quote + contact
 *   doceditor.ts    generated-pdf                                           → quote|jobCard + contact
 *   recordSigning.ts  for-signing PDF                                       → quote|jobCard + contact
 *   signing/complete.ts  signed PDF                                         → quote|jobCard + contact
 *   jobcards.ts     check-in / check-out photos                             → jobCard + contact
 *   portal.ts       portal-upload                                           → vehicle + contact
 *
 * So under the union rule a user with contact access but no quote access could
 * download the quote's invoice and its signed contract — the pricing and the
 * terms — because the customer was attached to the file. Contact access was
 * never meant to confer that.
 *
 * ORDER, and why it is this order:
 *
 *  - quote > jobCard. These never co-occur on a document this app creates: every
 *    generator above binds one source or the other (doceditor's `legacyRecord`
 *    throws on both; recordSigning takes one; complete.ts copies the request's
 *    single source). The pair is therefore unobservable in practice, and the
 *    order is chosen to match `signing/binding.ts` VERBATIM. That matters for a
 *    concrete reason rather than tidiness: recordSigning.ts stamps the SAME
 *    {quoteId, jobCardId, contactId} triple onto the Document and onto the
 *    SignatureRequest built from it. If the two precedence lists disagreed, a
 *    legacy row carrying both would put the request under one record and its own
 *    PDF under another — two answers for one file, which is the drift this rule
 *    exists to prevent.
 *
 *  - quote/jobCard > vehicle. Same argument `signing/binding.ts` makes: the
 *    commercial and work records are what a document is ABOUT. A vehicle is the
 *    asset they concern, not the deal.
 *
 *  - vehicle > contact. A vehicle belongs to a contact, so the vehicle is the
 *    more specific fact. `portal.ts` sets both on a customer upload and the
 *    vehicle is what the upload is about.
 *
 * Documents with NO link at all (uploadRepoDocument files them bare) have no
 * governing record: `null`, which the caller must treat as a refusal. They
 * remain reachable by their uploader and by documents.view_all, which is exactly
 * what the union rule already did with them.
 */
export function governingDocumentLink(document: DocumentLinks): GoverningDocumentLink | null {
  if (document.quoteId) return { kind: "quote", id: document.quoteId };
  if (document.jobCardId) return { kind: "jobcard", id: document.jobCardId };
  if (document.vehicleId) return { kind: "vehicle", id: document.vehicleId };
  if (document.contactId) return { kind: "contact", id: document.contactId };
  return null;
}
