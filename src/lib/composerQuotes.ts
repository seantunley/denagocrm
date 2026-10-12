import { quotePdfFileName } from "./quoteEmail";

/** A quote the email composer offers to attach. `label` is what the sender sees; `fileName` what the customer receives. */
export type ComposerQuote = { id: string; label: string; fileName: string; draft: boolean };

/**
 * Which of a customer's quotes the composer offers, newest first as given.
 *
 * The ones worth sending: current (not replaced by a revision), with something
 * on them, and still live — a cancelled or declined quote is not offered. The
 * send action checks every one of these again, and the permission, on its own.
 */
/**
 * The statuses a quote may be attached in: live ones. A declined or cancelled
 * quote is not sent out again. ONE list, read by the composer when it offers
 * quotes AND by the send action when it checks what was posted — the browser's
 * list is a convenience, the server's is the rule.
 */
export const COMPOSER_QUOTE_STATUSES: readonly string[] = ["draft", "sent", "accepted"];

export function composerQuotes(
  quotes: { id: string; number: number; status: string; supersededAt: Date | null; deletedAt?: Date | null; items: unknown[] }[],
  canSendQuotes: boolean,
): ComposerQuote[] {
  if (!canSendQuotes) return [];
  return quotes
    .filter((q) => !q.deletedAt && !q.supersededAt && q.items.length > 0 && COMPOSER_QUOTE_STATUSES.includes(q.status))
    .map((q) => ({ id: q.id, label: `Q-${q.number}`, fileName: quotePdfFileName(q.number), draft: q.status === "draft" }));
}
