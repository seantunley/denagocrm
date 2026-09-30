/**
 * "Email quote" — the pure half: the default wording, the merge fields, and the
 * order the send happens in. The server action (app/actions/quoteEmail.ts) wires
 * real dependencies into deliverQuoteEmail; the test wires fakes.
 *
 * No company name, phone or address lives here. Every one of those comes from
 * the workspace's own Company Profile through {{company_name}} and the sender's
 * signature, the same as every other customer email.
 */
import { renderTemplate } from "./template";

/** The setting that points at the Email template to use instead of the default. */
export const QUOTE_EMAIL_TEMPLATE_SETTING = "QUOTE_EMAIL_TEMPLATE_ID";

/** Merge fields a quote email can use, as shown in Settings → Email. */
export const QUOTE_EMAIL_FIELDS = ["first_name", "name", "quote_number", "total", "company_name", "sender_name"] as const;

export const DEFAULT_QUOTE_EMAIL = {
  subject: "Your quote {{quote_number}} from {{company_name}}",
  body:
    "Hi {{first_name}},\n\n" +
    "Thank you for your interest. Your quote {{quote_number}} is attached as a PDF.\n\n" +
    "If you have any questions, or would like to go ahead, just reply to this email.\n\n" +
    "Kind regards,\n{{sender_name}}",
};

export type QuoteEmailVars = Record<(typeof QUOTE_EMAIL_FIELDS)[number], string>;

export function quoteEmailVars(input: {
  customerName: string;
  quoteNumber: number;
  total: string;
  companyName: string;
  senderName: string;
}): QuoteEmailVars {
  const name = input.customerName.trim();
  return {
    name,
    first_name: name.split(/\s+/)[0] ?? "",
    quote_number: `Q-${input.quoteNumber}`,
    total: input.total,
    company_name: input.companyName,
    sender_name: input.senderName,
  };
}

export function composeQuoteEmail(
  template: { subject: string; body: string } | null,
  vars: QuoteEmailVars,
): { subject: string; body: string } {
  const source = template ?? DEFAULT_QUOTE_EMAIL;
  return { subject: renderTemplate(source.subject, vars), body: renderTemplate(source.body, vars) };
}

export const quotePdfFileName = (quoteNumber: number) => `Quote-Q-${quoteNumber}.pdf`;

export type QuoteEmailAttachment = { filename: string; content: Buffer; contentType: string };

/**
 * The send, in the only safe order.
 *
 *  1. Render the PDF from the same renderer Print / PDF uses. No PDF, no email.
 *  2. Send it. A failed send stops here: the quote is NOT marked sent and nothing
 *     is logged as sent, because the customer has nothing.
 *  3. Only then mark the quote sent (if it was a draft) and log it.
 *
 * Marking sent before the send, or regardless of its result, is how a quote
 * reads "sent" in the CRM while the customer never received it.
 */
export async function deliverQuoteEmail(
  input: { to: string; subject: string; body: string; fileName: string },
  deps: {
    renderPdf: () => Promise<Buffer | null>;
    send: (mail: { to: string; subject: string; body: string; attachments: QuoteEmailAttachment[] }) => Promise<{ ok: boolean; error?: string }>;
    markSentIfDraft: () => Promise<boolean>;
    record: (mail: { to: string; subject: string; body: string; fileName: string; markedSent: boolean }) => Promise<void>;
  },
): Promise<{ ok: true; markedSent: boolean } | { ok: false; error: string }> {
  const pdf = await deps.renderPdf();
  if (!pdf) return { ok: false, error: "The quote PDF could not be generated. Nothing was sent." };
  const sent = await deps.send({
    to: input.to,
    subject: input.subject,
    body: input.body,
    attachments: [{ filename: input.fileName, content: pdf, contentType: "application/pdf" }],
  });
  if (!sent.ok) return { ok: false, error: sent.error || "The email could not be sent." };
  const markedSent = await deps.markSentIfDraft();
  await deps.record({ ...input, markedSent });
  return { ok: true, markedSent };
}
