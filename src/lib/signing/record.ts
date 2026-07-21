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

/** True when the record has an open request that should lock it against edits. */
export function isLockedForSigning(state: RecordSigningState): boolean {
  // Any CLOSED request (completed/declined/voided/expired/rejected) leaves the
  // record editable again; only a live request locks it.
  return !!state && !isRequestClosed(state.status);
}
