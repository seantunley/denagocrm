import "server-only";
import { prisma } from "@/lib/db";
import { isRequestClosed } from "./status";

/**
 * The signing state shown on a quote / job-card page. We surface the most recent
 * non-voided hub request for the record so the panel can render live status
 * (sent / viewed / signed / declined) and the signer's secure link.
 */
export type RecordSigningState = {
  requestId: string;
  status: string;
  title: string;
  createdAt: Date;
  sentAt: Date | null;
  completedAt: Date | null;
  signedPdfHash: string | null;
  signedDocId: string | null;
  recipients: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    token: string;
    status: string;
    viewedAt: Date | null;
    signedAt: Date | null;
    declinedAt: Date | null;
  }[];
} | null;

/** Latest active (non-voided) hub request for a quote / job card, if any. */
export async function activeRecordRequest(opts: { quoteId?: string | null; jobCardId?: string | null }): Promise<RecordSigningState> {
  const where = opts.quoteId ? { quoteId: opts.quoteId } : opts.jobCardId ? { jobCardId: opts.jobCardId } : null;
  if (!where) return null;
  const req = await prisma.signatureRequest.findFirst({
    where: { ...where, status: { not: "voided" } },
    orderBy: { createdAt: "desc" },
    include: { recipients: { orderBy: { order: "asc" } } },
  });
  if (!req) return null;
  return {
    requestId: req.id,
    status: req.status,
    title: req.title,
    createdAt: req.createdAt,
    sentAt: req.sentAt,
    completedAt: req.completedAt,
    signedPdfHash: req.signedPdfHash,
    signedDocId: req.signedDocId,
    recipients: req.recipients.map((r) => ({
      id: r.id, name: r.name, email: r.email, phone: r.phone, token: r.token,
      status: r.status, viewedAt: r.viewedAt, signedAt: r.signedAt, declinedAt: r.declinedAt,
    })),
  };
}

/**
 * Everything the signature card needs for one quote, gathered in a single call.
 *
 * The card only ever lived on the quote record page — a server component that
 * could read all of this inline. Embedding the same card in the quote EDITOR
 * means a client dialog needs the same facts on demand, and needs them again
 * after every signing action, so they are resolved here instead of assembled
 * twice in two different ways.
 */
export type QuoteSigningView = {
  status: string;
  /**
   * A request is in flight, so the quote must not be edited. Computed here
   * because isRequestClosed() is server-only and the editor is a client
   * component — it cannot work this out for itself.
   */
  locked: boolean;
  signedAt: Date | null;
  signedByName: string | null;
  signedPdfHash: string | null;
  dealerSignedAt: Date | null;
  dealerSignedByName: string | null;
  hasSavedSignature: boolean;
  workflows: { id: string; name: string }[];
  state: RecordSigningState;
};

/** True when the record has an open request that should lock it against edits. */
export function isLockedForSigning(state: RecordSigningState): boolean {
  // Any CLOSED request (completed/declined/voided/expired/rejected) leaves the
  // record editable again; only a live request locks it.
  return !!state && !isRequestClosed(state.status);
}
