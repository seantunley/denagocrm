import { prisma } from "./db";
import { sentQuoteFamilies, type QrOutcomes } from "./flowQr";

/**
 * QR → SALE (Sean, 2026-11-04). The customers a QR code brought in are the contacts it created (their source is the
 * QR's — lib/flowQr.qrSource, stamped by lib/whatsapp on a new WhatsApp contact). From them: quotes sent (a revision
 * counts once, with its original), and their won deals with the deals' value. In this workspace only.
 */
export async function qrOutcomes(tenantId: string, source: string, showValue: boolean): Promise<QrOutcomes> {
  const contacts = await prisma.contact.findMany({ where: { tenantId, source }, select: { id: true } });
  const ids = contacts.map((c) => c.id);
  if (!ids.length) return { people: 0, quotes: 0, won: 0, wonCents: showValue ? 0 : null };
  const [quoteRows, won] = await Promise.all([
    // Every version, whatever its status: a declined original can have a sent revision (sentQuoteFamilies).
    prisma.quote.findMany({
      where: { tenantId, deletedAt: null, OR: [{ contactId: { in: ids } }, { lead: { contactId: { in: ids } } }] },
      select: { id: true, revisionOfId: true, status: true },
    }),
    prisma.lead.groupBy({ by: ["currency"], where: { tenantId, deletedAt: null, status: "won", contactId: { in: ids } }, _count: { _all: true }, _sum: { valueCents: true } }),
  ]);
  // Every win counts; the value is the base currency's (NULL) — one figure can't hold two currencies.
  const wonCount = won.reduce((sum, row) => sum + row._count._all, 0);
  const baseCents = won.find((row) => row.currency === null)?._sum.valueCents ?? 0;
  return { people: ids.length, quotes: sentQuoteFamilies(quoteRows), won: wonCount, wonCents: showValue ? baseCents : null };
}
