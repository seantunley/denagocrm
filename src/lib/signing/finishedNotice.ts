/**
 * What a signing link says once its document is finished.
 *
 * A link stops working the moment its request reaches a final state. The person
 * holding it still deserves to know which final state: "you signed this, here is
 * your copy" and "this was withdrawn" are different conversations, and a bare
 * "not found" is neither. Nothing here shows or reopens the document.
 *
 * Pure, so the wording — including the rule that an unbranded page names nobody
 * — is tested directly. Dates arrive already formatted for the workspace.
 */
export type FinishedNotice = {
  title: string;
  body: string;
  /** Offer "send my copy again". Only ever to the address already on file. */
  canResendCopy: boolean;
};

export type FinishedNoticeInput = {
  /** The request's status, or "deleted" for one that was removed. */
  status: string;
  /** This link's own recipient. */
  recipient: { status: string; signedOn: string | null; declinedOn: string | null };
  completedOn: string | null;
  /**
   * The last DAY the link worked. A link expires at midnight — already the next
   * day — so naming the expiry instant's date would say "expired on the 24th" to
   * someone whose quote was valid until the 23rd.
   */
  lastValidDay: string | null;
  /** Masked address the signed copy goes to, when one is on file. */
  emailHint: string | null;
  /** The signed copy has already been emailed to that address. */
  copySent: boolean;
  /** The workspace emails signed copies (Settings → Automatic jobs & messages). */
  signedCopiesOn: boolean;
  /** The company's name when the page is branded; null names nobody. */
  sender: string | null;
};

export function finishedNotice(input: FinishedNoticeInput): FinishedNotice {
  const sender = input.sender ?? "the sender";
  const Sender = input.sender ?? "The sender";
  const on = (when: string | null) => (when ? ` on ${when}` : "");

  if (input.status === "completed") {
    const canResendCopy = Boolean(input.emailHint) && input.signedCopiesOn;
    const copy = canResendCopy
      ? input.copySent
        ? ` We emailed the signed copy to ${input.emailHint}.`
        : ` The signed copy is being emailed to ${input.emailHint}.`
      : ` Ask ${sender} for your signed copy.`;
    return input.recipient.status === "signed"
      ? { title: "Signed ✓", body: `You signed this document${on(input.recipient.signedOn)}.${copy}`, canResendCopy }
      : { title: "Completed", body: `This document was completed${on(input.completedOn)}.${copy}`, canResendCopy };
  }
  if (input.status === "declined") {
    return input.recipient.status === "declined"
      ? {
          title: "Declined",
          body: `You declined this document${on(input.recipient.declinedOn)}. If that was a mistake, contact ${sender} and they can send it to you again.`,
          canResendCopy: false,
        }
      : { title: "No longer available", body: "This document was declined, so it can no longer be signed.", canResendCopy: false };
  }
  if (input.status === "voided") {
    return {
      title: "Withdrawn",
      body: `${Sender} withdrew this document, so there is nothing for you to sign. If you were expecting it, they can send you a new link.`,
      canResendCopy: false,
    };
  }
  if (input.status === "expired") {
    return {
      title: "Link expired",
      body: `This signing link has expired${input.lastValidDay ? ` — it was valid until ${input.lastValidDay}` : ""}. Ask ${sender} to send an updated document.`,
      canResendCopy: false,
    };
  }
  return {
    title: "Document unavailable",
    body: `This signing link is no longer active. Please contact ${sender}.`,
    canResendCopy: false,
  };
}
