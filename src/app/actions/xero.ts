"use server";

import { revalidatePath } from "next/cache";
import { ActionRefusal, asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { withActingStaffScope } from "@/lib/actingScope";
import { actingTenantId } from "@/lib/actingTenant";
import { prisma } from "@/lib/db";
import { getAccessibleQuoteIds, requireAnyPermission, requireQuoteAccess } from "@/lib/permissions";
import { requireTenantOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { logError } from "@/lib/errorLog";
import { formatZAR } from "@/lib/format";
import { withCurrency } from "@/lib/currencyRules";
import { payableTotalCents } from "@/lib/pricing";
import { loadBillToFleet, quoteBillTo } from "@/lib/quoteBillTo";
import { QUOTE_GONE } from "@/lib/quoteDelivery";
import { getRegionalSettings, getWorkspaceSetting, putWorkspaceSetting, resolveIntegrationField } from "@/lib/settings";
import { XeroNotConnected, xeroClient, type XeroClient } from "@/lib/xero";
import { formatInvoiceNumber } from "@/lib/invoiceNumber";
import {
  XERO_FEE_ITEM_KEYS,
  XERO_STALE_SEND_MS,
  XERO_TAX_CHOICES_KEY,
  parseXeroTaxChoices,
  withXeroTaxChoice,
  xeroTaxRateChoices,
  xeroInvoiceCancelled,
  xeroSendPlan,
  xeroSendUncertain,
  xeroStatusAfterFailedSend,
  buildXeroInvoice,
  feeKindForXero,
  parseXeroItemLink,
  quoteTaxRates,
  type XeroFeeKind,
  totalsDiffer,
  xeroReference,
  legacyXeroReference,
  nextXeroRefreshBatch,
  XERO_PAYMENTS_SOURCE_KEY,
  XERO_AUTO_CHECK_KEY,
} from "@/lib/xeroInvoice";
import { REFRESH_ALL_CAP, openXeroInvoicesWhere, refreshOneFromXero, syncPaymentsFromXero, tryFilePdf } from "@/lib/xeroSync";

/** Xero's refusals and "not connected" are things a person can fix — say them; anything else is logged. */
function refuseXero(err: unknown): never {
  if (err instanceof XeroNotConnected) refuse(err.message);
  if (err instanceof Error && err.message.startsWith("Xero:")) refuse(err.message);
  throw err;
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
      // An invoice goes to Xero, never a quote: accepted, with its own INV number.
      if (quote.status !== "accepted" || !quote.invoiceNumber) refuse("Only an issued invoice (an accepted quote with its INV number) can be sent to Xero.");
      if (quote.xeroExcludedAt) refuse(`${formatInvoiceNumber(quote.invoiceNumber)} is marked "Not for Xero". Undo that first if it should go to Xero.`);
      const plan = xeroSendPlan(quote);
      if (!plan.ok) {
        refuse(`${formatInvoiceNumber(quote.invoiceNumber)} is already in Xero as ${quote.xeroInvoiceNumber ?? "an invoice"}. Use Refresh to update it.`);
      }
      if (!quote.contactId && !quote.fleetId) refuse("Link this quote to a customer first — the Xero invoice is filed on the customer.");

      // The claim re-checks everything the read above checked, in ONE conditional
      // write: a cancel or move back to draft that lands in between finds it claimed
      // (xeroLockReason), or this finds it no longer accepted, or its Xero state
      // moved on. A voided invoice being replaced STAYS linked until the new one is
      // recorded (xeroSendPlan), so a retry after a failure replaces the same one.
      // The claim's own timestamp is its token: every later write is conditional on
      // it, so a send whose claim was taken over or cleared (Xero reconnected to
      // another organisation) can't write its result into the CRM.
      const claimAt = new Date();
      const claimed = await prisma.quote.updateMany({
        where: {
          id: quoteId,
          tenantId,
          status: "accepted",
          deletedAt: null,
          supersededAt: null,
          invoiceNumber: { not: null },
          xeroExcludedAt: null,
          xeroInvoiceId: quote.xeroInvoiceId,
          xeroStatus: quote.xeroStatus,
          // A send still running holds it; only a dead one (past any function's lifetime) is taken over.
          OR: [{ xeroStatus: null }, { NOT: { xeroStatus: "SENDING" } }, { xeroSentAt: { lt: new Date(Date.now() - XERO_STALE_SEND_MS) } }],
        },
        data: { xeroStatus: "SENDING", xeroSentAt: claimAt },
      });
      if (claimed.count !== 1) refuse("This invoice is already being sent to Xero, or it has just changed — reload the page.");
      const ourClaim = { id: quoteId, tenantId, xeroStatus: "SENDING", xeroSentAt: claimAt };
      let createAttempted = false;

      try {
        const fleet = await loadBillToFleet(prisma, quote.fleetId);
        const billTo = quoteBillTo(quote, fleet);
        const reference = xeroReference(quote);
        const client = await xeroClient(tenantId);

        // 2 — a send that already reached Xero is adopted, never repeated: under
        // today's Reference, or the longer one sends used before 2026-11-11.
        let invoice =
          (await client.findInvoiceByReference(reference)) ?? (await client.findInvoiceByReference(legacyXeroReference(quote)));
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
          const taxTypes = await client.taxTypes(quoteTaxRates(quote), parseXeroTaxChoices(await getWorkspaceSetting(tenantId, XERO_TAX_CHOICES_KEY)));
          const salesAccount = (await resolveIntegrationField(tenantId, "xero", "XERO_SALES_ACCOUNT")) ?? "";

          // Lines whose product is linked to a Xero item carry its CURRENT code (looked up by the
          // stored ID, so a code renamed in Xero still works) and the item's sales account.
          const productIds = [...new Set(quote.items.map((item) => item.productId).filter((id): id is string => Boolean(id)))];
          const linked = productIds.length
            ? await prisma.product.findMany({ where: { id: { in: productIds }, tenantId, xeroItemId: { not: null } }, select: { id: true, name: true, xeroItemId: true } })
            : [];
          // Fee lines follow Settings → Xero: the item for delivery fees, or for other fees.
          const feeLinks = {
            delivery: parseXeroItemLink(await getWorkspaceSetting(tenantId, XERO_FEE_ITEM_KEYS.delivery)),
            other: parseXeroItemLink(await getWorkspaceSetting(tenantId, XERO_FEE_ITEM_KEYS.other)),
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
              id: quote.id,
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
          // A replacement for a voided invoice has its own key, the same on every retry (xeroSendPlan).
          createAttempted = true;
          invoice = await client.createInvoice(payload, plan.idempotencyKey);
        }

        // Recorded only while OUR claim still stands, with the customer's Xero contact
        // in the same transaction — if Xero was reconnected to another organisation
        // meanwhile, nothing from the old one is written back.
        const sentInvoice = invoice;
        const sentContact = contact;
        const recorded = await prisma.$transaction(async (tx) => {
          const saved = await tx.quote.updateMany({
            where: ourClaim,
            data: {
              xeroInvoiceId: sentInvoice.id,
              xeroInvoiceNumber: sentInvoice.number,
              xeroStatus: sentInvoice.status,
              xeroTotalCents: sentInvoice.totalCents,
              xeroSentAt: new Date(),
              xeroSentByName: user.name,
            },
          });
          if (saved.count !== 1) return false;
          // The customer's Xero contact, remembered on the record the invoice is billed to.
          if (sentContact) {
            if (quote.fleetId) await tx.fleet.updateMany({ where: { id: quote.fleetId, tenantId }, data: { xeroContactId: sentContact.contactId } });
            else if (quote.contactId) await tx.contact.updateMany({ where: { id: quote.contactId, tenantId }, data: { xeroContactId: sentContact.contactId } });
          }
          // Sending to Xero IS the invoice step on the Deliveries board (Sean, 2026-11-11):
          // no separate "Mark invoiced" upload — Xero's PDF is the invoice document.
          const marked = await tx.quote.updateMany({ where: { id: quoteId, tenantId, invoicedAt: null }, data: { invoicedAt: new Date() } });
          return { invoicedNow: marked.count === 1 };
        });
        if (!recorded) {
          await logError("xero-send", new Error("send finished after its claim was cleared"), `quote=${quote.id} invoice=${invoice.id}`, { tenantId, alert: false });
          refuse(
            `Xero made invoice ${invoice.number ?? invoice.id}, but this invoice changed in the CRM while it was being sent (Xero was reconnected, or another send took over), so it wasn't linked. Check that invoice in Xero.`,
          );
        }
        const pdfFiled = await tryFilePdf(client, { tenantId, quote, invoice, user });

        await logAudit({
          action: "quote.sent_to_xero",
          summary: `Q-${quote.number} ${adopted ? "linked to the existing" : "sent to"} Xero invoice ${invoice.number ?? invoice.id}${contact?.created ? " (new Xero contact created)" : ""}`,
          contactId: quote.contactId,
          leadId: quote.leadId,
          user,
        });
        if (recorded.invoicedNow) {
          await logAudit({
            action: "fulfilment.invoiced",
            summary: `Q-${quote.number} invoiced — sent to Xero as ${invoice.number ?? "an invoice"}`,
            contactId: quote.contactId,
            leadId: quote.leadId,
            user,
          });
        }
        // An invoice ADOPTED from Xero may already have money against it — its full
        // read carries the payments (a search result doesn't). A new draft has none.
        const fromXero = adopted
          ? await client
              .getInvoice(invoice.id)
              .then((full) => syncPaymentsFromXero({ tenantId, quoteId, invoice: full, user }))
              .catch(() => "Its payments couldn't be read from Xero yet — press Refresh.")
          : null;
        revalidatePath("/deliveries");
        if (quote.contactId) revalidatePath(`/contacts/${quote.contactId}`);

        const moneyFmt = withCurrency(await getRegionalSettings(), quote.currency);
        const crmTotal = payableTotalCents(quote);
        const parts = [
          adopted ? `Already in Xero as ${invoice.number ?? "an invoice"} — linked, nothing new created.` : `In Xero as ${invoice.number ?? "a draft invoice"}.`,
          contact?.created ? "New Xero contact created." : contact ? "Matched the customer's Xero contact." : "",
          pdfFiled ? "Xero's PDF is filed on the customer." : "Xero's PDF couldn't be fetched yet — press Refresh to file it.",
          fromXero ?? "",
          missingItems.length
            ? `No longer in Xero, so sent without an item code: ${missingItems.join(", ")} — re-link it (product page, or Settings → Integrations → Xero for fees).`
            : "",
          totalsDiffer(invoice.totalCents, crmTotal)
            ? `Check it: Xero's total is ${formatZAR(invoice.totalCents ?? 0, moneyFmt)}, the quote's is ${formatZAR(crmTotal, moneyFmt)}.`
            : "",
        ];
        return { success: parts.filter(Boolean).join(" ") };
      } catch (err) {
        // Still our claim: release it (xeroStatusAfterFailedSend). Failed before Xero
        // was asked to create anything → back as it was. Failed after, or while
        // retrying an unfinished send → Xero may have it: UNCONFIRMED, locked until a
        // new send checks Xero. The voided invoice being replaced stays linked.
        await prisma.quote.updateMany({
          where: ourClaim,
          data: { xeroStatus: xeroStatusAfterFailedSend(quote.xeroStatus, createAttempted) },
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
 * Settings → Integrations → Xero → Sales tax: every VAT % at which Xero has more
 * than one live sales rate, with the options — loaded when the owner asks, not on
 * every page view. A South African organisation has six at 15%.
 */
export async function listXeroTaxRateChoices(): Promise<{ groups: ReturnType<typeof xeroTaxRateChoices> } | { error: string }> {
  return withActingStaffScope(async () => {
    await requireTenantOwner();
    const tenantId = await actingTenantId();
    try {
      // A % with a saved choice is always offered, so a stale choice can be changed or cleared.
      const saved = Object.keys(parseXeroTaxChoices(await getWorkspaceSetting(tenantId, XERO_TAX_CHOICES_KEY))).map(Number);
      return { groups: xeroTaxRateChoices(await (await xeroClient(tenantId)).listTaxRates(), saved) };
    } catch (err) {
      if (err instanceof XeroNotConnected || (err instanceof Error && err.message.startsWith("Xero:"))) return { error: err.message };
      await logError("xero-tax-rates", err, undefined, { tenantId, alert: false });
      return { error: "Xero's tax rates couldn't be loaded. Try again in a moment." };
    }
  });
}

/**
 * Save which Xero sales rate the CRM's VAT at `pct`% goes to — checked against
 * Xero's live sales rates at that %. An empty choice CLEARS it, so a choice that
 * went stale (its rate deactivated in Xero) never leaves the owner stuck.
 */
export async function chooseXeroTaxRate(pct: number, formData: FormData): Promise<ActionResult> {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await requireTenantOwner();
      const tenantId = await actingTenantId();
      const taxType = String(formData.get("taxType") ?? "").trim();
      if (!Number.isFinite(pct)) refuse("Choose a tax rate.");
      const choices = parseXeroTaxChoices(await getWorkspaceSetting(tenantId, XERO_TAX_CHOICES_KEY));
      if (!taxType) {
        if (!choices[String(pct)]) refuse("Choose a tax rate.");
        await putWorkspaceSetting(tenantId, XERO_TAX_CHOICES_KEY, withXeroTaxChoice(choices, pct, null));
        await logAudit({ action: "xero.tax_rate_cleared", summary: `Xero tax rate choice for ${pct}% VAT cleared`, user });
        revalidatePath("/settings/integrations");
        return { success: `Choice for ${pct}% VAT cleared.` };
      }
      let option: { taxType: string; name: string } | undefined;
      try {
        const rates = await (await xeroClient(tenantId)).listTaxRates();
        option = xeroTaxRateChoices(rates, [pct]).find((g) => g.pct === pct)?.options.find((o) => o.taxType === taxType);
      } catch (err) {
        refuseXero(err);
      }
      if (!option) refuse(`That rate isn't one of Xero's live sales rates at ${pct}% any more — reload the list.`);
      await putWorkspaceSetting(tenantId, XERO_TAX_CHOICES_KEY, withXeroTaxChoice(choices, pct, option));
      await logAudit({ action: "xero.tax_rate_chosen", summary: `VAT at ${pct}% goes to Xero as "${option.name}" (${option.taxType})`, user });
      revalidatePath("/settings/integrations");
      return { success: `VAT at ${pct}% now goes to Xero as ${option.name}.` };
    }),
  );
}

/**
 * "Not for Xero" (Sean, 2026-11-11: historical invoices "were processed in a
 * different way… Their invoices do not belong in Xero"): marked one by one, an
 * invoice is never offered to Xero, and its payments are recorded in the CRM as
 * before. Undo takes it back. Refused for an invoice already in Xero (void it
 * there first) or mid-send. deliveries.manage, this invoice's own workspace,
 * audited; the write re-checks the state it read.
 */
export async function setNotForXero(quoteId: string, exclude: boolean): Promise<ActionResult> {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await requireQuoteAccess(quoteId, "deliveries.manage");
      const tenantId = await actingTenantId();
      const quote = await prisma.quote.findFirst({
        where: { id: quoteId, tenantId },
        select: { number: true, invoiceNumber: true, contactId: true, leadId: true, xeroInvoiceId: true, xeroInvoiceNumber: true, xeroStatus: true, xeroExcludedAt: true },
      });
      if (!quote) refuse(QUOTE_GONE);
      const label = quote.invoiceNumber ? formatInvoiceNumber(quote.invoiceNumber) : `Q-${quote.number}`;
      if (exclude) {
        if (quote.xeroExcludedAt) return { success: `${label} is already marked "Not for Xero".` };
        if (xeroSendUncertain(quote.xeroStatus)) refuse("A send to Xero is in progress or didn't finish — settle it first.");
        if (quote.xeroInvoiceId && !xeroInvoiceCancelled(quote.xeroStatus)) refuse(`${label} is already in Xero as ${quote.xeroInvoiceNumber ?? "an invoice"} — void it in Xero first.`);
      }
      const updated = await prisma.quote.updateMany({
        where: exclude
          ? { id: quoteId, tenantId, xeroExcludedAt: null, xeroInvoiceId: quote.xeroInvoiceId, xeroStatus: quote.xeroStatus }
          : { id: quoteId, tenantId, xeroExcludedAt: { not: null } },
        data: exclude ? { xeroExcludedAt: new Date(), xeroExcludedByName: user.name } : { xeroExcludedAt: null, xeroExcludedByName: null },
      });
      if (updated.count !== 1) refuse("This invoice changed meanwhile — reload the page.");
      await logAudit({
        action: exclude ? "quote.not_for_xero" : "quote.for_xero_again",
        summary: exclude ? `${label} marked "Not for Xero" — processed outside Xero` : `${label} can be sent to Xero again`,
        contactId: quote.contactId,
        leadId: quote.leadId,
        user,
      });
      for (const path of ["/invoices", "/deliveries", `/deals/${quoteId}`]) revalidatePath(path);
      if (quote.contactId) revalidatePath(`/contacts/${quote.contactId}`);
      return { success: exclude ? `${label} won't be offered to Xero.` : `${label} can be sent to Xero again.` };
    }),
  );
}

/**
 * Settings → Integrations → Xero → "Payments come from Xero" (on by default once
 * Xero is connected). Off puts the CRM's own deposit and payment forms back on
 * every invoice — kept for the day Xero changes (Sean, 2026-11-11). Owner only,
 * this workspace only, audited.
 */
export async function setXeroPaymentsSource(formData: FormData): Promise<ActionResult> {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await requireTenantOwner();
      const tenantId = await actingTenantId();
      const fromXero = formData.get("fromXero") === "on";
      await putWorkspaceSetting(tenantId, XERO_PAYMENTS_SOURCE_KEY, fromXero ? "xero" : "crm");
      await logAudit({
        action: "xero.payments_source",
        summary: fromXero ? "Payments now come from Xero — recorded there, brought back by Refresh" : "Payments are recorded in the CRM again (not brought back from Xero)",
        user,
      });
      // The hourly check's box shows only while payments come from Xero — absent, leave it as it was.
      if (formData.get("autoCheckShown") === "1") {
        const autoCheck = formData.get("autoCheck") === "on";
        if (((await getWorkspaceSetting(tenantId, XERO_AUTO_CHECK_KEY)) !== "off") !== autoCheck) {
          await putWorkspaceSetting(tenantId, XERO_AUTO_CHECK_KEY, autoCheck ? "on" : "off");
          await logAudit({
            action: "xero.auto_check",
            summary: autoCheck ? "Xero is checked for payments automatically every hour" : "The hourly automatic Xero payments check is switched off",
            user,
          });
        }
      }
      for (const path of ["/settings/integrations", "/invoices", "/deliveries"]) revalidatePath(path);
      return { success: fromXero ? "Payments now come from Xero." : "Payments are recorded in the CRM again." };
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
        await putWorkspaceSetting(tenantId, XERO_FEE_ITEM_KEYS[kind], "");
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
      await putWorkspaceSetting(tenantId, XERO_FEE_ITEM_KEYS[kind], JSON.stringify({ id: item.id, code: item.code, name: item.name }));
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
      try {
        const done = await refreshOneFromXero(await xeroClient(tenantId), tenantId, quoteId, user);
        return { success: done.message };
      } catch (err) {
        refuseXero(err);
      }
    }),
  );
}

/**
 * Invoices page → "Refresh all from Xero": the open invoices this person can see
 * that are in Xero and not yet paid, through the same routine as the per-invoice
 * Refresh — number, status, PDF, and the deposit when Xero shows money received.
 * Up to 25 a press, never-tried / longest-ago-tried first; each is marked tried
 * BEFORE it is tried, success or not, so the next press reaches the next 25 (review
 * of #1071). One that fails is counted and named, never hides the rest.
 */
export async function refreshAllXeroInvoices(): Promise<ActionResult> {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await requireAnyPermission("deliveries.manage");
      const tenantId = await actingTenantId();
      const accessible = await getAccessibleQuoteIds(user);
      const open = await prisma.quote.findMany({
        where: openXeroInvoicesWhere(tenantId, accessible),
        select: { id: true, number: true, xeroCheckedAt: true },
      });
      if (open.length === 0) return { success: "Nothing to refresh — every invoice in Xero is paid or settled." };
      const quotes = nextXeroRefreshBatch(open, REFRESH_ALL_CAP);
      let client: XeroClient;
      try {
        client = await xeroClient(tenantId);
      } catch (err) {
        refuseXero(err);
      }
      // Tried — before trying, so a failure can't pin the same invoices to the front.
      await prisma.quote.updateMany({ where: { tenantId, id: { in: quotes.map((q) => q.id) } }, data: { xeroCheckedAt: new Date() } });
      let withPayments = 0;
      const failed: string[] = [];
      for (const quote of quotes) {
        try {
          if ((await refreshOneFromXero(client, tenantId, quote.id, user)).paymentsSaid) withPayments += 1;
        } catch (err) {
          failed.push(`Q-${quote.number}`);
          if (!(err instanceof ActionRefusal || err instanceof XeroNotConnected || (err instanceof Error && err.message.startsWith("Xero:")))) {
            await logError("xero-refresh-all", err, `quote=${quote.id}`, { tenantId, alert: false });
          }
        }
      }
      revalidatePath("/invoices");
      return {
        success: [
          `Refreshed ${quotes.length - failed.length} of ${quotes.length} from Xero.`,
          withPayments ? `${withPayments} had payment news from Xero — open them to see.` : "",
          failed.length ? `Couldn't refresh ${failed.join(", ")} — open it and press Refresh to see why.` : "",
          open.length > quotes.length ? `${open.length - quotes.length} more still to check — press again.` : "",
        ].filter(Boolean).join(" "),
      };
    }),
  );
}

