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
export function composerQuotes(
  quotes: { id: string; number: number; status: string; supersededAt: Date | null; deletedAt?: Date | null; items: unknown[] }[],
  canSendQuotes: boolean,
): ComposerQuote[] {
  if (!canSendQuotes) return [];
  return quotes
    .filter((q) => !q.deletedAt && !q.supersededAt && q.items.length > 0 && ["draft", "sent", "accepted"].includes(q.status))
    .map((q) => ({ id: q.id, label: `Q-${q.number}`, fileName: quotePdfFileName(q.number), draft: q.status === "draft" }));
}
