/** Which certificates a WhatsApp answer sends to the person who asked (assistantWarrantyCertificate.ts). Pure. */

export const MAX_CERTIFICATES_SENT = 3;
/** The person asked for a certificate (any wording that names one). */
export function wantsCertificate(question: string): boolean {
  return /\bcert(ificate)?s?\b/i.test(question);
}

/** Filed-document ids linked in the answer (/api/files/<id>), first ones first, no repeats. */
export function linkedDocumentIds(answer: string): string[] {
  const ids = [...answer.matchAll(/\/api\/files\/([A-Za-z0-9_-]{8,40})/g)].map((m) => m[1]);
  return [...new Set(ids)].slice(0, MAX_CERTIFICATES_SENT);
}
