import { Prisma } from "@prisma/client";
import { prisma } from "./db";

/**
 * The suppliers on a deal (DealVendor). A deal is its LEAD — one file across every quote on it — or the quote
 * itself when the quote has no lead, the same rule the deal page uses to gather its quotes.
 */
export const dealKey = (quote: { id: string; leadId: string | null }): { leadId: string } | { quoteId: string } =>
  quote.leadId ? { leadId: quote.leadId } : { quoteId: quote.id };

/**
 * Declare a supplier on a quote's deal, once (a partial unique index backs the "once"). The caller has already
 * checked access to the quote and that the supplier is a live one of the quote's workspace; the composite tenant
 * FKs refuse anything else. Returns whether it was newly added.
 */
export async function linkVendorToDeal(input: {
  tenantId: string;
  quote: { id: string; leadId: string | null };
  vendorId: string;
  userId: string;
}): Promise<boolean> {
  const key = dealKey(input.quote);
  const existing = await prisma.dealVendor.findFirst({ where: { tenantId: input.tenantId, vendorId: input.vendorId, ...key }, select: { id: true } });
  if (existing) return false;
  try {
    await prisma.dealVendor.create({ data: { tenantId: input.tenantId, vendorId: input.vendorId, createdById: input.userId, ...key } });
    return true;
  } catch (error) {
    // Two uploads at once: the other one added it.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
    throw error;
  }
}
