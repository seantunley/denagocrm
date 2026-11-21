/** Which certificates a WhatsApp answer sends to the person who asked (assistantWarrantyCertificate.ts). Pure. */

export const MAX_CERTIFICATES_SENT = 3;

/**
 * The certificate made out to the vehicle's owner NOW. After a transfer, the filed one still names the previous owner,
 * so it is never sent or offered as the new owner's — a new one is issued for them. Used by the email send, DAX's
 * warranty lookup and DAX's WhatsApp send.
 */
export function currentOwnersCertificate<T extends { contactId: string | null }>(docs: readonly T[], ownerId: string): T | null {
  return docs.find((d) => d.contactId === ownerId) ?? null;
}

export const REISSUE_FOR_OWNER = "The filed certificate names a previous owner. Issue a new certificate for the current owner first.";

/** The person asked for a certificate (any wording that names one). */
export function wantsCertificate(question: string): boolean {
  return /\bcert(ificate)?s?\b/i.test(question);
}

/** Filed-document ids linked in the answer (/api/files/<id>), first ones first, no repeats. */
export function linkedDocumentIds(answer: string): string[] {
  const ids = [...answer.matchAll(/\/api\/files\/([A-Za-z0-9_-]{8,40})/g)].map((m) => m[1]);
  return [...new Set(ids)].slice(0, MAX_CERTIFICATES_SENT);
}
