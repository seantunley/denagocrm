"use server";

import { revalidatePath } from "next/cache";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { withActingStaffScope } from "@/lib/actingScope";
import { actingTenantId } from "@/lib/actingTenant";
import { prisma } from "@/lib/db";
import { requireQuoteAccess, type PermissionUser } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { logError } from "@/lib/errorLog";
import { formatZAR } from "@/lib/format";
import { withCurrency } from "@/lib/currencyRules";
import { payableTotalCents } from "@/lib/pricing";
import { loadBillToFleet, quoteBillTo } from "@/lib/quoteBillTo";
import { QUOTE_GONE } from "@/lib/quoteDelivery";
import { getRegionalSettings, resolveIntegrationField } from "@/lib/settings";
import { deleteFile, saveFile } from "@/lib/storage";
import { XeroNotConnected, xeroClient, type XeroClient } from "@/lib/xero";
import {
  buildXeroInvoice,
  quoteTaxRates,
  totalsDiffer,
  xeroPdfFileName,
  xeroReference,
  xeroStatusLabel,
  type XeroInvoiceSummary,
} from "@/lib/xeroInvoice";

/** A send that has held the quote this long is assumed dead (a crashed request) and may be retried. */
const STALE_SEND_MS = 2 * 60_000;

/** Xero's refusals and "not connected" are things a person can fix — say them; anything else is logged. */
function refuseXero(err: unknown): never {
  if (err instanceof XeroNotConnected) refuse(err.message);
  if (err instanceof Error && err.message.startsWith("Xero:")) refuse(err.message);
  throw err;
}

/**
 * File Xero's PDF on the CUSTOMER (and the quote) as the accounting invoice. A
 * newer copy — after the invoice was approved or paid in Xero — becomes the
 * current version and the older one is kept, marked as replaced, like any other
 * re-uploaded document.
 */
async function fileXeroPdf(input: {
  tenantId: string;
  quote: { id: string; number: number; contactId: string | null };
  invoice: XeroInvoiceSummary;
  pdf: Buffer;
  user: PermissionUser;
}): Promise<void> {
  const fileName = xeroPdfFileName(input.invoice.number, input.quote.number);
  const storedName = await saveFile(input.pdf, fileName, "application/pdf", input.tenantId);
  try {
    const document = await prisma.document.create({
      data: {
        tenantId: input.tenantId,
        fileName,
        storedName,
        mimeType: "application/pdf",
        sizeBytes: input.pdf.length,
        contactId: input.quote.contactId,
        quoteId: input.quote.id,
        tag: "accounting-invoice",
        uploadedById: input.user.id,
      },
      select: { id: true },
    });
    await prisma.document.updateMany({
      where: { tenantId: input.tenantId, quoteId: input.quote.id, tag: "accounting-invoice", replacedById: null, id: { not: document.id } },
      data: { replacedById: document.id },
    });
  } catch (error) {
    await deleteFile(storedName).catch(() => {});
    throw error;
  }
}

/** Fetch and file the PDF; a failure here never undoes the invoice — it is said, and Refresh tries again. */
async function tryFilePdf(client: XeroClient, input: Omit<Parameters<typeof fileXeroPdf>[0], "pdf">): Promise<boolean> {
  try {
    await fileXeroPdf({ ...input, pdf: await client.getInvoicePdf(input.invoice.id) });
    return true;
  } catch (err) {
    await logError("xero-pdf", err, `quote=${input.quote.id} invoice=${input.invoice.id}`, { tenantId: input.tenantId, alert: false });
    return false;
  }
}

/**
 * "Send to Xero" (Sean, 2026-11-10): the quote's invoice, made in Xero as a DRAFT
 * that matches the CRM invoice; Xero's invoice number kept on the quote, Xero's
 * contact id on the customer, Xero's PDF filed on the customer as the accounting
 * invoice. Same door as invoicing on the Deliveries board.
 *
 * NEVER TWO INVOICES FOR ONE QUOTE, three ways:
 *  1. the quote is claimed first (xeroStatus "SENDING"), so a second click is refused;
 *  2. before creating anything, Xero is searched for a live invoice already carrying
 *     this quote's Reference — a send that succeeded in Xero but whose reply was lost
 *     is FOUND and adopted, however long ago it was (Xero's idempotency keys only
 *     last six minutes, so they can't be the safeguard on their own);
 *  3. the create still carries the quote's id as Xero's Idempotency-Key, for the
 *     seconds-apart retry the search could race.
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
      if (quote.xeroInvoiceId) refuse(`Q-${quote.number} is already in Xero as ${quote.xeroInvoiceNumber ?? "an invoice"}. Use Refresh to update it.`);
      if (!quote.contactId && !quote.fleetId) refuse("Link this quote to a customer first — the Xero invoice is filed on the customer.");

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
        const fleet = await loadBillToFleet(prisma, quote.fleetId);
        const billTo = quoteBillTo(quote, fleet);
        const reference = xeroReference(quote);
        const client = await xeroClient(tenantId);

        // 2 — a send that already reached Xero is adopted, never repeated.
        let invoice = await client.findInvoiceByReference(reference);
        let contact: { contactId: string; created: boolean } | null = invoice?.contactId ? { contactId: invoice.contactId, created: false } : null;
        const adopted = Boolean(invoice);

        if (!invoice) {
          const known = quote.fleetId
            ? (await prisma.fleet.findFirst({ where: { id: quote.fleetId, tenantId }, select: { xeroContactId: true } }))?.xeroContactId ?? null
            : quote.contact?.xeroContactId ?? null;
          contact = await client.resolveContact(
            { name: billTo.name, email: billTo.email, phone: billTo.phone, addressLines: billTo.addressLines ?? (billTo.address ? [billTo.address] : []), vatNumber: billTo.vatNumber },
            known,
          );
          const taxTypes = await client.taxTypes(quoteTaxRates(quote));
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
            },
            { contactId: contact.contactId, salesAccount, taxTypes },
          );
          invoice = await client.createInvoice(payload, `crm-quote-${quote.id}`);
        }

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
        // The customer's Xero contact, remembered on the record the invoice is billed to.
        if (contact) {
          if (quote.fleetId) await prisma.fleet.updateMany({ where: { id: quote.fleetId, tenantId }, data: { xeroContactId: contact.contactId } });
          else if (quote.contactId) await prisma.contact.updateMany({ where: { id: quote.contactId, tenantId }, data: { xeroContactId: contact.contactId } });
        }
        const pdfFiled = await tryFilePdf(client, { tenantId, quote, invoice, user });

        await logAudit({
          action: "quote.sent_to_xero",
          summary: `Q-${quote.number} ${adopted ? "linked to the existing" : "sent to"} Xero invoice ${invoice.number ?? invoice.id}${contact?.created ? " (new Xero contact created)" : ""}`,
          contactId: quote.contactId,
          leadId: quote.leadId,
          user,
        });
        revalidatePath("/deliveries");
        if (quote.contactId) revalidatePath(`/contacts/${quote.contactId}`);

        const moneyFmt = withCurrency(await getRegionalSettings(), quote.currency);
        const crmTotal = payableTotalCents(quote);
        const parts = [
          adopted ? `Already in Xero as ${invoice.number ?? "an invoice"} — linked, nothing new created.` : `In Xero as ${invoice.number ?? "a draft invoice"}.`,
          contact?.created ? "New Xero contact created." : contact ? "Matched the customer's Xero contact." : "",
          pdfFiled ? "Xero's PDF is filed on the customer." : "Xero's PDF couldn't be fetched yet — press Refresh to file it.",
          totalsDiffer(invoice.totalCents, crmTotal)
            ? `Check it: Xero's total is ${formatZAR(invoice.totalCents ?? 0, moneyFmt)}, the quote's is ${formatZAR(crmTotal, moneyFmt)}.`
            : "",
        ];
        return { success: parts.filter(Boolean).join(" ") };
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

/**
 * "Refresh from Xero" — Xero's number, status and total as they are now. When the
 * invoice has moved on (approved, paid, renumbered) or its PDF isn't filed yet,
 * Xero's current PDF is filed as the new version of the accounting invoice.
 */
export async function refreshXeroInvoice(quoteId: string): Promise<ActionResult> {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await requireQuoteAccess(quoteId, "deliveries.manage");
      const tenantId = await actingTenantId();
      const quote = await prisma.quote.findFirst({
        where: { id: quoteId, tenantId },
        select: { id: true, number: true, contactId: true, xeroInvoiceId: true, xeroInvoiceNumber: true, xeroStatus: true },
      });
      if (!quote) refuse(QUOTE_GONE);
      if (!quote.xeroInvoiceId) refuse(`Q-${quote.number} has not been sent to Xero yet.`);
      let client: XeroClient;
      let invoice: XeroInvoiceSummary;
      try {
        client = await xeroClient(tenantId);
        invoice = await client.getInvoice(quote.xeroInvoiceId);
      } catch (err) {
        refuseXero(err);
      }
      await prisma.quote.updateMany({
        where: { id: quoteId, tenantId, xeroInvoiceId: quote.xeroInvoiceId },
        data: { xeroInvoiceNumber: invoice.number, xeroStatus: invoice.status, xeroTotalCents: invoice.totalCents },
      });
      const changed = invoice.status !== quote.xeroStatus || invoice.number !== quote.xeroInvoiceNumber;
      const filed = await prisma.document.count({ where: { tenantId, quoteId, tag: "accounting-invoice", deletedAt: null } });
      const pdfFiled = changed || filed === 0 ? await tryFilePdf(client, { tenantId, quote, invoice, user }) : false;
      revalidatePath("/deliveries");
      if (quote.contactId) revalidatePath(`/contacts/${quote.contactId}`);
      return {
        success: `Xero: ${invoice.number ?? "invoice"} · ${xeroStatusLabel(invoice.status)}${pdfFiled ? " — latest PDF filed on the customer." : ""}`,
      };
    }),
  );
}
