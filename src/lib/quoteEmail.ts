/**
 * "Email quote" — the order the send happens in. The server action
 * (app/actions/quoteEmail.ts) wires real dependencies into deliverQuoteEmail;
 * the test wires fakes.
 *
 * The wording is the "quote" kind in lib/signing/emailTemplates.ts, edited in
 * Settings → Email templates like the signing emails, and rendered into the same
 * branded shell. No company name, phone or address lives in code.
 */

export const quotePdfFileName = (quoteNumber: number) => `Quote-Q-${quoteNumber}.pdf`;

export type QuoteEmailAttachment = { filename: string; content: Buffer; contentType: string };

/**
 * The send, in the only safe order.
 *
 *  1. Render the PDF from the same renderer Print / PDF uses. No PDF, no email.
 *  2. Send it (sendEmail writes the timeline entry once SMTP accepts it). A
 *     failed send stops here: the quote is NOT marked sent, because the customer
 *     has nothing.
 *  3. Only then mark the quote sent (if it was a draft) and audit it.
 *
 * Marking sent before the send, or regardless of its result, is how a quote
 * reads "sent" in the CRM while the customer never received it.
 */
export async function deliverQuoteEmail(
  input: { to: string; fileName: string },
  deps: {
    renderPdf: () => Promise<Buffer | null>;
    send: (mail: { to: string; attachments: QuoteEmailAttachment[] }) => Promise<{ ok: boolean; error?: string }>;
    markSentIfDraft: () => Promise<boolean>;
    audit: (sent: { to: string; fileName: string; markedSent: boolean }) => Promise<void>;
  },
): Promise<{ ok: true; markedSent: boolean } | { ok: false; error: string }> {
  const pdf = await deps.renderPdf();
  if (!pdf) return { ok: false, error: "The quote PDF could not be generated. Nothing was sent." };
  const sent = await deps.send({
    to: input.to,
    attachments: [{ filename: input.fileName, content: pdf, contentType: "application/pdf" }],
  });
  if (!sent.ok) return { ok: false, error: sent.error || "The email could not be sent." };
  const markedSent = await deps.markSentIfDraft();
  await deps.audit({ ...input, markedSent });
  return { ok: true, markedSent };
}
