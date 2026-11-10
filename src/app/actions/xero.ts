"use server";

import { revalidatePath } from "next/cache";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { withActingStaffScope } from "@/lib/actingScope";
import { actingTenantId } from "@/lib/actingTenant";
import { prisma } from "@/lib/db";
import { requireQuoteAccess, type PermissionUser } from "@/lib/permissions";
import { requireTenantOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { logError } from "@/lib/errorLog";
import { formatZAR } from "@/lib/format";
import { withCurrency } from "@/lib/currencyRules";
import { payableTotalCents } from "@/lib/pricing";
import { loadBillToFleet, quoteBillTo } from "@/lib/quoteBillTo";
import { QUOTE_GONE } from "@/lib/quoteDelivery";
import { getRegionalSettings, getSetting, putSetting, resolveIntegrationField } from "@/lib/settings";
import { deleteFile, saveFile } from "@/lib/storage";
import { XeroNotConnected, xeroClient, type XeroClient } from "@/lib/xero";
import {
  XERO_FEE_ITEM_KEYS,
  buildXeroInvoice,
  feeKindForXero,
  parseXeroItemLink,
  quoteTaxRates,
  type XeroFeeKind,
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
        let missingItems: string[] = [];

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

          // Lines whose product is linked to a Xero item carry its CURRENT code (looked up by the
          // stored ID, so a code renamed in Xero still works) and the item's sales account.
          const productIds = [...new Set(quote.items.map((item) => item.productId).filter((id): id is string => Boolean(id)))];
          const linked = productIds.length
            ? await prisma.product.findMany({ where: { id: { in: productIds }, tenantId, xeroItemId: { not: null } }, select: { id: true, name: true, xeroItemId: true } })
            : [];
          // Fee lines follow Settings → Xero: the item for delivery fees, or for other fees.
          const feeLinks = {
            delivery: parseXeroItemLink(await getSetting(XERO_FEE_ITEM_KEYS.delivery)),
            other: parseXeroItemLink(await getSetting(XERO_FEE_ITEM_KEYS.other)),
          };
          let items: Array<(typeof quote.items)[number] & { xeroItemCode?: string; xeroAccountCode?: string | null }> = quote.items;
          let fees: Array<(typeof quote.fees)[number] & { xeroItemCode?: string; xeroAccountCode?: string | null }> = quote.fees;
          const feeNeedsItems = quote.fees.some((fee) => feeLinks[feeKindForXero(fee.kind)]);
          if (linked.length || feeNeedsItems) {
            const inXero = new Map((await client.listItems()).map((x) => [x.id, x]));
            missingItems = linked.filter((p) => !inXero.has(p.xeroItemId!)).map((p) => p.name);
            const byProduct = new Map(linked.map((p) => [p.id, inXero.get(p.xeroItemId!)]));
            items = quote.items.map((item) => {
              const x = item.productId ? byProduct.get(item.productId) : undefined;
              return x ? { ...item, xeroItemCode: x.code, xeroAccountCode: x.accountCode } : item;
            });
            fees = quote.fees.map((fee) => {
              const link = feeLinks[feeKindForXero(fee.kind)];
              const x = link ? inXero.get(link.id) : undefined;
              if (link && !x) missingItems.push(feeKindForXero(fee.kind) === "delivery" ? "delivery fees" : "other fees");
              return x ? { ...fee, xeroItemCode: x.code, xeroAccountCode: x.accountCode } : fee;
            });
            missingItems = [...new Set(missingItems)];
          }
          const payload = buildXeroInvoice(
            {
              number: quote.number,
              invoiceNumber: quote.invoiceNumber,
              taxInclusive: quote.taxInclusive,
              currency: quote.currency,
              invoicedAt: quote.invoicedAt,
              items,
              fees,
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
          missingItems.length
            ? `No longer in Xero, so sent without an item code: ${missingItems.join(", ")} — re-link it (product page, or Settings → Integrations → Xero for fees).`
            : "",
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
 * The product page's "Xero item" dropdown: the items Xero sells, loaded when the
 * owner opens it (not on every page view). Owner only, as editing a product is.
 */
export async function listXeroItems(): Promise<{ items: Array<{ id: string; code: string; name: string }> } | { error: string }> {
  return withActingStaffScope(async () => {
    await requireTenantOwner();
    const tenantId = await actingTenantId();
    try {
      const items = await (await xeroClient(tenantId)).listItems();
      return { items: items.map(({ id, code, name }) => ({ id, code, name })) };
    } catch (err) {
      if (err instanceof XeroNotConnected || (err instanceof Error && err.message.startsWith("Xero:"))) return { error: err.message };
      await logError("xero-items", err, undefined, { tenantId, alert: false });
      return { error: "Xero's items couldn't be loaded. Try again in a moment." };
    }
  });
}

/**
 * Link a product to a Xero item (or unlink with an empty choice). The item is
 * checked against Xero's list, so only a real, sellable item can be stored. The
 * SKU is not touched — the two are separate on purpose.
 */
export async function linkProductToXeroItem(productId: string, formData: FormData): Promise<ActionResult> {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await requireTenantOwner();
      const tenantId = await actingTenantId();
      const product = await prisma.product.findFirst({ where: { id: productId, tenantId, deletedAt: null }, select: { name: true } });
      if (!product) refuse("That product is not in this workspace.");
      const itemId = String(formData.get("xeroItemId") ?? "").trim();
      if (!itemId) {
        await prisma.product.updateMany({ where: { id: productId, tenantId }, data: { xeroItemId: null, xeroItemCode: null, xeroItemName: null } });
        await logAudit({ action: "product.xero_item_unlinked", summary: `${product.name} unlinked from its Xero item`, user });
        revalidatePath(`/products/${productId}`);
        return { success: "Unlinked from Xero." };
      }
      let item;
      try {
        item = (await (await xeroClient(tenantId)).listItems()).find((x) => x.id === itemId);
      } catch (err) {
        refuseXero(err);
      }
      if (!item) refuse("That item isn't in Xero (or isn't sold) any more — reload the list.");
      await prisma.product.updateMany({
        where: { id: productId, tenantId },
        data: { xeroItemId: item.id, xeroItemCode: item.code, xeroItemName: item.name || null },
      });
      await logAudit({ action: "product.xero_item_linked", summary: `${product.name} linked to Xero item ${item.code}`, user });
      revalidatePath(`/products/${productId}`);
      return { success: `Linked to Xero item ${item.code}.` };
    }),
  );
}

/**
 * Settings → Integrations → Xero: the Xero item delivery fees (or other fees) are
 * sent under. Checked against Xero's list like a product link; empty unsets it.
 */
export async function linkFeeToXeroItem(kind: XeroFeeKind, formData: FormData): Promise<ActionResult> {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await requireTenantOwner();
      const tenantId = await actingTenantId();
      if (!(kind in XERO_FEE_ITEM_KEYS)) refuse("Unknown fee kind.");
      const label = kind === "delivery" ? "delivery fees" : "other fees";
      const itemId = String(formData.get("xeroItemId") ?? "").trim();
      if (!itemId) {
        await putSetting(XERO_FEE_ITEM_KEYS[kind], "");
        await logAudit({ action: "xero.fee_item_unlinked", summary: `Xero item for ${label} cleared`, user });
        revalidatePath("/settings/integrations");
        return { success: `No Xero item for ${label}.` };
      }
      let item;
      try {
        item = (await (await xeroClient(tenantId)).listItems()).find((x) => x.id === itemId);
      } catch (err) {
        refuseXero(err);
      }
      if (!item) refuse("That item isn't in Xero (or isn't sold) any more — reload the list.");
      await putSetting(XERO_FEE_ITEM_KEYS[kind], JSON.stringify({ id: item.id, code: item.code, name: item.name }));
      await logAudit({ action: "xero.fee_item_linked", summary: `Xero item for ${label} set to ${item.code}`, user });
      revalidatePath("/settings/integrations");
      return { success: `${label[0].toUpperCase()}${label.slice(1)} go to Xero as ${item.code}.` };
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
