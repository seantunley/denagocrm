import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma, basePrisma } from "./db";
import { CLOSED_REQUEST_STATUSES } from "./signing/status";

type QuoteEditableFields = {
  deletedAt: Date | null;
  signToken: string | null;
  signedAt: Date | null;
  supersededAt: Date | null;
  status: string;
};

/**
 * A quote is frozen once a signing link exists, it has been signed, it was
 * superseded by a revision, it has left draft, or it is trashed — customers must
 * never see a quote change under them (revise instead). The open-SignatureRequest
 * check (below) is separate because the signing hub creates a request WITHOUT
 * setting the legacy quote.signToken marker.
 */
function isFrozen(quote: QuoteEditableFields | null): boolean {
  return (
    !quote ||
    Boolean(quote.deletedAt) ||
    Boolean(quote.signToken) ||
    Boolean(quote.signedAt) ||
    Boolean(quote.supersededAt) ||
    quote.status !== "draft"
  );
}

/**
 * True when the quote has a live (non-closed) hub SignatureRequest. The signing
 * hub doesn't set quote.signToken, so this is the marker that a signing document
 * is out with the customer and the quote must not be edited under them.
 */
export async function hasOpenSignatureRequest(
  client: Pick<Prisma.TransactionClient, "signatureRequest">,
  quoteId: string,
): Promise<boolean> {
  const open = await client.signatureRequest.findFirst({
    where: { quoteId, deletedAt: null, status: { notIn: [...CLOSED_REQUEST_STATUSES] } },
    select: { id: true },
  });
  return Boolean(open);
}

/**
 * PREFLIGHT / DISPLAY ONLY. Reads editability without a lock, so it must never
 * be the sole gate before a mutation — the quote can be sent / signed / revised
 * between this read and the write (TOCTOU). Use {@link withEditableQuote} to
 * mutate. Kept for read paths (e.g. deciding whether to render edit controls).
 */
export async function quoteLocked(quoteId: string): Promise<boolean> {
  const quote = await prisma.quote.findUnique({ where: { id: quoteId } });
  if (isFrozen(quote)) return true;
  const open = await prisma.signatureRequest.findFirst({
    where: { quoteId, deletedAt: null, status: { notIn: [...CLOSED_REQUEST_STATUSES] } },
    select: { id: true },
  });
  return Boolean(open);
}

/**
 * Run `fn` iff the quote is still editable, holding a row lock for the whole
 * mutation. The quote row is locked FOR UPDATE and editability is re-checked
 * inside the transaction — including whether an open signing request exists — so
 * a concurrent send / sign / revision / signing-start can't slip in between the
 * check and the write. Returns `{ ok: false }` when the quote is frozen (or gone)
 * and `fn` never runs. Callers do their own RBAC first.
 */
export async function withEditableQuote<T>(
  quoteId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<{ ok: true; result: T } | { ok: false }> {
  return basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "Quote" WHERE id = ${quoteId} FOR UPDATE`;
    const quote = await tx.quote.findUnique({
      where: { id: quoteId },
      select: { deletedAt: true, signToken: true, signedAt: true, supersededAt: true, status: true },
    });
    if (isFrozen(quote)) return { ok: false as const };
    if (await hasOpenSignatureRequest(tx, quoteId)) return { ok: false as const };
    const result = await fn(tx);
    return { ok: true as const, result };
  });
}
