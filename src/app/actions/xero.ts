"use server";

import { revalidatePath } from "next/cache";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { withActingStaffScope } from "@/lib/actingScope";
import { actingTenantId } from "@/lib/actingTenant";
import { prisma } from "@/lib/db";
import { requireQuoteAccess } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { formatZAR } from "@/lib/format";
import { payableTotalCents } from "@/lib/pricing";
import { loadBillToFleet, quoteBillTo } from "@/lib/quoteBillTo";
import { QUOTE_GONE } from "@/lib/quoteDelivery";
import { resolveIntegrationField } from "@/lib/settings";
import { XeroNotConnected, createXeroInvoice, getXeroInvoice } from "@/lib/xero";
import { buildXeroInvoice, totalsDiffer, xeroStatusLabel } from "@/lib/xeroInvoice";

/** A send that has held the quote this long is assumed dead (a crashed request), and may be retried. */
const STALE_SEND_MS = 2 * 60_000;

/** Xero's refusals and "not connected" are things the person can fix — say them; anything else is logged. */
function refuseXero(err: unknown): never {
  if (err instanceof XeroNotConnected) refuse(err.message);
  if (err instanceof Error && err.message.startsWith("Xero:")) refuse(err.message);
  throw err;
}

/**
 * "Send to Xero" — make the quote's invoice in Xero as a DRAFT and keep Xero's
 * invoice number on the quote (Sean, 2026-11-10). The CRM's own invoice number is
 * untouched; it goes into the Xero invoice's Reference.
 *
 * Same door as invoicing on the Deliveries board (deliveries.manage on this quote).
 * One send per quote: the row is CLAIMED first (xeroStatus "SENDING") so a second
 * click is refused here, and Xero is given the quote's id as an idempotency key so
 * a retry after a lost reply returns the same invoice rather than a second one.
 */
export async function sendQuoteToXero(quoteId: string): Promise<ActionResult> {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await requireQuoteAccess(quoteId, "deliveries.manage");
      const tenantId = await actingTenantId();
      const quote = await prisma.quote.findFirst({
        where: { id: quoteId, tenantId },
        include: { items: { orderBy: { sortOrder: "asc" } }, fees: { orderBy: { sortOrder: "asc" } }, contact: true, lead: true },
      });
      if (!quote) refuse(QUOTE_GONE);
      if (quote.status !== "accepted") refuse("Only an accepted quote can be sent to Xero.");
      if (quote.xeroInvoiceId) refuse(`Q-${quote.number} is already in Xero as ${quote.xeroInvoiceNumber ?? "a draft invoice"}. Use Refresh to update it.`);

      const claimed = await prisma.quote.updateMany({
        where: {
          id: quoteId,
          tenantId,
          xeroInvoiceId: null,
          OR: [{ xeroStatus: null }, { NOT: { xeroStatus: "SENDING" } }, { xeroSentAt: { lt: new Date(Date.now() - STALE_SEND_MS) } }],
        },
        data: { xeroStatus: "SENDING", xeroSentAt: new Date() },
      });
      if (claimed.count !== 1) refuse("This quote is already being sent to Xero.");

      try {
        const billTo = quoteBillTo(quote, await loadBillToFleet(prisma, quote.fleetId));
        const salesAccount = (await resolveIntegrationField(tenantId, "xero", "XERO_SALES_ACCOUNT")) ?? "";
        const payload = buildXeroInvoice(
          {
            number: quote.number,
            invoiceNumber: quote.invoiceNumber,
            taxInclusive: quote.taxInclusive,
            currency: quote.currency,
            invoicedAt: quote.invoicedAt,
            items: quote.items,
            fees: quote.fees,
            billTo: { name: billTo.name, email: billTo.email },
          },
          salesAccount,
        );
        const invoice = await createXeroInvoice(tenantId, payload, `crm-quote-${quote.id}`);
        await prisma.quote.updateMany({
          where: { id: quoteId, tenantId },
          data: {
            xeroInvoiceId: invoice.id,
            xeroInvoiceNumber: invoice.number,
            xeroStatus: invoice.status,
            xeroTotalCents: invoice.totalCents,
            xeroSentAt: new Date(),
            xeroSentByName: user.name,
          },
        });
        await logAudit({
          action: "quote.sent_to_xero",
          summary: `Q-${quote.number} sent to Xero as ${invoice.number ?? "a draft invoice"}`,
          contactId: quote.contactId,
          leadId: quote.leadId,
          user,
        });
        revalidatePath("/deliveries");
        const crmTotal = payableTotalCents(quote);
        const differs = totalsDiffer(invoice.totalCents, crmTotal);
        return {
          success: differs
            ? `In Xero as ${invoice.number ?? "a draft"} — but Xero's total (${formatZAR(invoice.totalCents ?? 0)}) differs from the quote's (${formatZAR(crmTotal)}). Check the VAT on its lines in Xero.`
            : `In Xero as ${invoice.number ?? "a draft invoice"}.`,
        };
      } catch (err) {
        // Release the claim so it can be tried again — only if nothing was recorded.
        await prisma.quote.updateMany({
          where: { id: quoteId, tenantId, xeroInvoiceId: null, xeroStatus: "SENDING" },
          data: { xeroStatus: null, xeroSentAt: null },
        });
        refuseXero(err);
      }
    }),
  );
}

/** "Refresh from Xero" — Xero's number, status and total as they are now (approved, paid, renumbered, voided). */
export async function refreshXeroInvoice(quoteId: string): Promise<ActionResult> {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      await requireQuoteAccess(quoteId, "deliveries.manage");
      const tenantId = await actingTenantId();
      const quote = await prisma.quote.findFirst({ where: { id: quoteId, tenantId }, select: { number: true, xeroInvoiceId: true } });
      if (!quote) refuse(QUOTE_GONE);
      if (!quote.xeroInvoiceId) refuse(`Q-${quote.number} has not been sent to Xero yet.`);
      let invoice;
      try {
        invoice = await getXeroInvoice(tenantId, quote.xeroInvoiceId);
      } catch (err) {
        refuseXero(err);
      }
      await prisma.quote.updateMany({
        where: { id: quoteId, tenantId, xeroInvoiceId: quote.xeroInvoiceId },
        data: { xeroInvoiceNumber: invoice.number, xeroStatus: invoice.status, xeroTotalCents: invoice.totalCents },
      });
      revalidatePath("/deliveries");
      return { success: `Xero: ${invoice.number ?? "invoice"} · ${xeroStatusLabel(invoice.status)}` };
    }),
  );
}
