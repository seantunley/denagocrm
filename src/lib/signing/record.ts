import "server-only";
import { prisma } from "@/lib/db";
import { isRequestClosed } from "./status";

/**
 * Signing state shown on quote/job-card pages. Public capabilities are excluded:
 * a manager must use the separately audited reveal action to recover one.
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
    recipients: req.recipients.map((recipient) => ({
      id: recipient.id,
      name: recipient.name,
      email: recipient.email,
      phone: recipient.phone,
      status: recipient.status,
      viewedAt: recipient.viewedAt,
      signedAt: recipient.signedAt,
      declinedAt: recipient.declinedAt,
    })),
  };
}

export type QuoteSigningView = {
  status: string;
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
  return !!state && !isRequestClosed(state.status);
}
