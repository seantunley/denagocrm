import "server-only";
import { randomBytes } from "node:crypto";
import { prisma } from "./db";
import { hashSignToken } from "./signing/tokens";
import { SECURE_LINK_TOKEN } from "./secureLinks";
import { documentRequestState, type DocumentRequestState } from "./documentRequestRules";

/**
 * Supplier document requests (lib/documentRequestRules.ts for the rules). The raw token exists only in the link —
 * the table keeps its SHA-256, as secure file links and signing links do, so a copy of the database opens nothing.
 */
export async function createDocumentRequest(input: {
  tenantId: string;
  quoteId: string;
  vendorId: string;
  documentType: string;
  sentTo: string;
  createdById: string;
  expiresAt: Date;
}): Promise<{ id: string; token: string }> {
  const token = randomBytes(32).toString("base64url");
  const row = await prisma.documentRequest.create({
    data: { ...input, sentTo: input.sentTo.slice(0, 300), token: hashSignToken(token) },
    select: { id: true },
  });
  return { id: row.id, token };
}

export type DocumentRequestView = {
  id: string;
  tenantId: string;
  quoteId: string;
  quoteNumber: number;
  vendorId: string;
  vendorName: string;
  documentType: string;
  createdById: string;
  expiresAt: Date;
  state: DocumentRequestState;
};

/** What a link in a supplier's hand asks for, and whether it still works. Null for an unknown link. */
export async function findDocumentRequest(token: string): Promise<DocumentRequestView | null> {
  if (!SECURE_LINK_TOKEN.test(token)) return null;
  const row = await prisma.documentRequest.findUnique({
    where: { token: hashSignToken(token) },
    select: {
      id: true, tenantId: true, quoteId: true, vendorId: true, documentType: true, createdById: true,
      expiresAt: true, revokedAt: true, fulfilledAt: true, vendor: { select: { name: true } },
    },
  });
  if (!row) return null;
  const quote = await prisma.quote.findFirst({ where: { id: row.quoteId, tenantId: row.tenantId }, select: { number: true } });
  if (!quote) return null;
  return {
    id: row.id, tenantId: row.tenantId, quoteId: row.quoteId, quoteNumber: quote.number, vendorId: row.vendorId,
    vendorName: row.vendor.name, documentType: row.documentType, createdById: row.createdById, expiresAt: row.expiresAt,
    state: documentRequestState(row, new Date()),
  };
}
