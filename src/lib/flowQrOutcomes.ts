import { prisma } from "./db";
import type { QrOutcomes } from "./flowQr";

/**
 * QR → SALE (Sean, 2026-11-04). The customers a QR code brought in are the contacts it created (their source is the
 * QR's — lib/flowQr.qrSource, stamped by lib/whatsapp on a new WhatsApp contact). From them: quotes sent (a revision
 * counts once, with its original), and their won deals with the deals' value. In this workspace only.
 */
export async function qrOutcomes(tenantId: string, source: string, showValue: boolean): Promise<QrOutcomes> {
  const contacts = await prisma.contact.findMany({ where: { tenantId, source }, select: { id: true } });
  const ids = contacts.map((c) => c.id);
  if (!ids.length) return { people: 0, quotes: 0, won: 0, wonCents: showValue ? 0 : null };
  const [quotes, won] = await Promise.all([
    prisma.quote.count({
      where: {
        tenantId, deletedAt: null, revisionOfId: null, status: { in: ["sent", "accepted"] },
        OR: [{ contactId: { in: ids } }, { lead: { contactId: { in: ids } } }],
      },
    }),
    prisma.lead.aggregate({ where: { tenantId, deletedAt: null, status: "won", contactId: { in: ids } }, _count: { _all: true }, _sum: { valueCents: true } }),
  ]);
  return { people: ids.length, quotes, won: won._count._all, wonCents: showValue ? won._sum.valueCents ?? 0 : null };
}
