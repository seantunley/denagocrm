import { redactForLog } from "./redactLog";

/**
 * WHAT OF A FINANCE HOUSE'S EMAIL IS KEPT (review of #1138; Sean, 2026-11-16: applicant information is not stored).
 * Their answer — "approved subject to a 10% deposit" — is the point; anything identifying the applicant that the
 * finance house copied into the body is not. So the CRM keeps the opening of the body only, with ID numbers, email
 * addresses, phone numbers and every long run of digits (account, card and policy numbers) masked. The full email
 * stays in the mailbox, with its attachments.
 */
export const KEPT_BODY_CHARS = 1500;

export function storedFinanceEmailBody(body: string): string {
  const masked = redactForLog(body)
    // Eight or more digits, spaces or dashes allowed between them: an account, card or policy number.
    .replace(/\d(?:[\s-]?\d){7,}/g, "[number]");
  const clipped = masked.length > KEPT_BODY_CHARS ? `${masked.slice(0, KEPT_BODY_CHARS).trimEnd()}…` : masked;
  return `${clipped}\n\n(Shortened, with ID, account and contact numbers masked. The full email is in the mailbox.)`;
}
