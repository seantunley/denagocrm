"use server";

import { revalidatePath } from "next/cache";
import { ActionRefusal, asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { withActingStaffScope } from "@/lib/actingScope";
import { actingTenantId } from "@/lib/actingTenant";
import { basePrisma, prisma } from "@/lib/db";
import { getAccessibleQuoteIds, requireAnyPermission, requireQuoteAccess, type PermissionUser } from "@/lib/permissions";
import { requireTenantOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { logError } from "@/lib/errorLog";
import { formatZAR } from "@/lib/format";
import { withCurrency } from "@/lib/currencyRules";
import { payableTotalCents } from "@/lib/pricing";
import { loadBillToFleet, quoteBillTo } from "@/lib/quoteBillTo";
import { QUOTE_GONE } from "@/lib/quoteDelivery";
import { getRegionalSettings, getWorkspaceSetting, putWorkspaceSetting, resolveIntegrationField } from "@/lib/settings";
import { deleteFile, saveFile } from "@/lib/storage";
import { XeroNotConnected, paymentsComeFromXero, xeroClient, type XeroClient } from "@/lib/xero";
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
  XERO_UNCONFIRMED,
  xeroStatusAfterFailedSend,
  buildXeroInvoice,
  feeKindForXero,
  parseXeroItemLink,
  quoteTaxRates,
  type XeroFeeKind,
  totalsDiffer,
  xeroPdfFileName,
  xeroReference,
  legacyXeroReference,
  xeroStatusLabel,
  type XeroInvoiceSummary,
  nextXeroRefreshBatch,
  planXeroPaymentSync,
  receivedAfterSync,
  xeroPaymentsComplete,
  XERO_PAYMENT_METHOD,
  XERO_PAYMENTS_SOURCE_KEY,
  type CrmPaymentState,
} from "@/lib/xeroInvoice";
import { lockQuoteLedger } from "@/lib/quoteLedger";

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
    // Filed only if the invoice STILL links this Xero invoice, checked under the
    // quote's row lock: a PDF fetched over a connection that has since been
    // switched to another organisation (forgetXeroLinks clears the link, locking
    // the same row), or for an invoice another send has since replaced, is
    // dropped — never filed on the customer (review of #1067).
    const filed = await basePrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Quote" WHERE id = ${input.quote.id} AND "tenantId" = ${input.tenantId} FOR UPDATE`;
      const stillLinked = await tx.quote.count({ where: { id: input.quote.id, tenantId: input.tenantId, xeroInvoiceId: input.invoice.id } });
      if (stillLinked !== 1) return false;
      const document = await tx.document.create({
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
      await tx.document.updateMany({
        where: { tenantId: input.tenantId, quoteId: input.quote.id, tag: "accounting-invoice", replacedById: null, id: { not: document.id } },
        data: { replacedById: document.id },
      });
      return true;
    });
    if (!filed) throw new Error("the invoice no longer links this Xero invoice — PDF not filed");
  } catch (error) {
    await deleteFile(storedName).catch(() => {});
    throw error;
  }
}

/**
 * "Payments get recorded in Xero and pushed back to the CRM" (Sean, 2026-11-11):
 * bring EVERY payment Xero has on this invoice into the CRM, so the CRM invoice
 * and statement match Xero — the earliest as the deposit (the step the Deliveries
 * board waits on), the rest as payments, each remembered by its Xero PaymentID so
 * nothing comes in twice; a payment removed in Xero is voided here (kept, marked).
 * Money recorded by hand that a Xero payment of the same amount accounts for is
 * LINKED, never duplicated; any that none accounts for is reported, never dropped
 * (planXeroPaymentSync).
 *
 * Under the quote's ledger lock (quoteLedger.ts), and only while the quote STILL
 * links the Xero invoice the payments were read from — an organisation switch
 * (forgetXeroLinks) updates the same row, so its payments can't land after it
 * (review of #1071). Never past the CRM invoice's total: Xero showing more is a
 * mismatch a person must look at, so nothing is brought. Only while payments come
 * from Xero (Settings → Integrations → Xero). Null = nothing to say.
 */
async function syncPaymentsFromXero(input: {
  tenantId: string;
  quoteId: string;
  invoice: XeroInvoiceSummary;
  user: PermissionUser;
}): Promise<string | null> {
  if (!(await paymentsComeFromXero(input.tenantId))) return null;
  // A partial answer from Xero must never clear a deposit or void a payment (review of #1071).
  if (!xeroPaymentsComplete(input.invoice)) {
    const fmt = withCurrency(await getRegionalSettings(), null);
    return `Xero says ${formatZAR(input.invoice.amountPaidCents, fmt)} has been paid, but its payment details don't add up to that — nothing was changed here. Press Refresh again later.`;
  }
  const done = await prisma.$transaction(async (tx) => {
    const ledger = await lockQuoteLedger(tx, input.quoteId, input.tenantId);
    if (!ledger || ledger.quote.xeroInvoiceId !== input.invoice.id) return null;
    const q = ledger.quote;
    const state: CrmPaymentState = {
      deposit: { paidAt: q.depositPaidAt, cents: q.depositPaidCents, xeroPaymentId: q.xeroDepositPaymentId, createdFromXero: q.xeroDepositCreated },
      payments: ledger.payments.map((p) => ({
        id: p.id, xeroPaymentId: p.xeroPaymentId, amountCents: p.amountCents, receivedAt: p.receivedAt, voidedAt: p.voidedAt,
        createdFromXero: p.method === XERO_PAYMENT_METHOD,
      })),
    };
    const plan = planXeroPaymentSync(state, input.invoice.payments);
    if (receivedAfterSync(state, plan) > ledger.totalCents) return { kind: "too-much" as const, quote: q, plan };
    const ours = { id: input.quoteId, tenantId: input.tenantId, xeroInvoiceId: input.invoice.id };
    const d = plan.deposit;
    if (d.kind === "set") {
      await tx.quote.updateMany({
        where: ours,
        data: { depositPaidAt: d.at, depositPaidCents: d.cents, xeroDepositPaymentId: d.xeroPaymentId, xeroDepositCreated: d.createdFromXero },
      });
    }
    if (d.kind === "link") await tx.quote.updateMany({ where: ours, data: { xeroDepositPaymentId: d.xeroPaymentId, xeroDepositCreated: false } });
    if (d.kind === "update") await tx.quote.updateMany({ where: ours, data: { depositPaidCents: d.cents, depositPaidAt: d.at } });
    if (d.kind === "clear") await tx.quote.updateMany({ where: ours, data: { depositPaidAt: null, depositPaidCents: null, xeroDepositPaymentId: null, xeroDepositCreated: false } });
    // Recorded by hand, its Xero match gone: the deposit stays; only the link goes.
    if (d.kind === "unlink") await tx.quote.updateMany({ where: ours, data: { xeroDepositPaymentId: null, xeroDepositCreated: false } });
    if (plan.unlink.length) {
      await tx.quotePayment.updateMany({ where: { id: { in: plan.unlink }, tenantId: input.tenantId, quoteId: input.quoteId }, data: { xeroPaymentId: null } });
    }
    // The payment that became the deposit: retired as a payment, so the money is counted once.
    if (plan.promote) {
      await tx.quotePayment.updateMany({
        where: { id: plan.promote, tenantId: input.tenantId, quoteId: input.quoteId, voidedAt: null },
        data: { voidedAt: new Date(), voidedByName: "Xero", voidReason: "Became the deposit — the earlier payment was removed in Xero" },
      });
    }
    for (const { paymentId, xero } of plan.restore) {
      await tx.quotePayment.updateMany({
        where: { id: paymentId, tenantId: input.tenantId, quoteId: input.quoteId },
        data: { voidedAt: null, voidedByName: null, voidReason: null, amountCents: xero.amountCents, receivedAt: xero.date },
      });
    }
    for (const x of plan.create) {
      await tx.quotePayment.create({
        data: {
          // The QUOTE's workspace, verbatim — the payment is the invoice's.
          tenantId: q.tenantId ?? input.tenantId,
          quoteId: input.quoteId,
          amountCents: x.amountCents,
          receivedAt: x.date,
          method: XERO_PAYMENT_METHOD,
          reference: x.reference,
          note: null,
          createdById: null,
          createdByName: "Xero",
          xeroPaymentId: x.id,
        },
      });
    }
    // Linked — or RE-linked, when Xero replaced the payment it was matched to (its old link goes).
    for (const { paymentId, xero } of plan.link) {
      await tx.quotePayment.updateMany({ where: { id: paymentId, tenantId: input.tenantId, quoteId: input.quoteId, voidedAt: null }, data: { xeroPaymentId: xero.id } });
    }
    for (const { paymentId, xero } of plan.update) {
      await tx.quotePayment.updateMany({ where: { id: paymentId, tenantId: input.tenantId, quoteId: input.quoteId }, data: { amountCents: xero.amountCents, receivedAt: xero.date } });
    }
    if (plan.void.length) {
      await tx.quotePayment.updateMany({
        where: { id: { in: plan.void }, tenantId: input.tenantId, quoteId: input.quoteId, voidedAt: null },
        data: { voidedAt: new Date(), voidedByName: "Xero", voidReason: "Removed in Xero" },
      });
    }
    await tx.quote.updateMany({ where: ours, data: { xeroAmountPaidCents: input.invoice.amountPaidCents } });
    return { kind: "synced" as const, quote: q, plan };
  });
  if (!done) return null;
  const fmt = withCurrency(await getRegionalSettings(), done.quote.currency);
  const money = (cents: number) => formatZAR(cents, fmt);
  if (done.kind === "too-much") {
    const handDeposit = done.plan.unmatched.depositCents;
    const handPayments = done.plan.unmatched.payments;
    if (handDeposit || handPayments.length) {
      // Money recorded by hand that Xero split differently (Sean, 2026-11-11) — not "Xero has too much".
      const ours = [handDeposit ? `deposit ${money(handDeposit)}` : "", ...handPayments.map((p) => `payment ${money(p.amountCents)}`)].filter(Boolean).join(", ");
      const xeros = input.invoice.payments.map((p) => money(p.amountCents)).join(", ") || "none";
      return `The CRM's own records for this invoice (${ours}) are split differently from Xero's payments (${xeros}), so they can't be matched — counting both would go past the invoice total, so nothing was changed. To line them up: untick "Payments come from Xero" in Settings → Integrations → Xero, void the CRM's records on this invoice, tick it again and press Refresh — or record the payments in Xero the same way the CRM has them.`;
    }
    return `Xero shows more received (${money(input.invoice.amountPaidCents)}) than this invoice's total — nothing was brought back. Check the invoice in Xero.`;
  }
  const { plan } = done;
  const said: string[] = [];
  if (plan.deposit.kind === "set") said.push(`deposit ${money(plan.deposit.cents)}`);
  if (plan.deposit.kind === "update") said.push(`deposit changed to ${money(plan.deposit.cents)}`);
  if (plan.deposit.kind === "clear") said.push("deposit removed (no longer in Xero)");
  if (plan.create.length) said.push(`${plan.create.length} payment${plan.create.length === 1 ? "" : "s"} (${money(plan.create.reduce((s, x) => s + x.amountCents, 0))})`);
  if (plan.update.length) said.push(`${plan.update.length} payment${plan.update.length === 1 ? "" : "s"} corrected`);
  if (plan.void.length) said.push(`${plan.void.length} payment${plan.void.length === 1 ? "" : "s"} voided (removed in Xero)`);
  if (plan.restore.length) said.push(`${plan.restore.length} payment${plan.restore.length === 1 ? "" : "s"} restored`);
  const linked = plan.link.length + (plan.deposit.kind === "link" ? 1 : 0);
  if (said.length || linked) {
    await logAudit({
      action: "quote.xero_payments_synced",
      summary: `Q-${done.quote.number}: from Xero — ${[...said, linked ? `${linked} recorded by hand matched to Xero` : ""].filter(Boolean).join(", ")}`,
      contactId: done.quote.contactId,
      leadId: done.quote.leadId,
      user: input.user,
    });
    revalidatePath("/deliveries");
    revalidatePath("/invoices");
    revalidatePath(`/deals/${input.quoteId}`);
  }
  const unmatched = [
    plan.unmatched.depositCents ? `a deposit of ${money(plan.unmatched.depositCents)}` : "",
    ...plan.unmatched.payments.map((p) => `a payment of ${money(p.amountCents)}`),
  ].filter(Boolean);
  return [
    said.length ? `Brought back from Xero: ${said.join(", ")}.` : "",
    unmatched.length ? `Recorded by hand in the CRM but not in Xero: ${unmatched.join(", ")} — record it in Xero (or void it in the CRM) so the two match.` : "",
    input.invoice.amountCreditedCents ? `Xero also has ${money(input.invoice.amountCreditedCents)} in credits on it — credits aren't brought back.` : "",
  ].filter(Boolean).join(" ") || null;
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
      // An invoice goes to Xero, never a quote: accepted, with its own INV number.
      if (quote.status !== "accepted" || !quote.invoiceNumber) refuse("Only an issued invoice (an accepted quote with its INV number) can be sent to Xero.");
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
 * Statuses a "Refresh all" has nothing to learn from: cancelled, or a send still to
 * settle. PAID too — once its payments have been brought back (xeroAmountPaidCents
 * set); one paid before payments came from Xero is still taken, to bring them.
 */
const REFRESH_ALL_SKIPS = ["PAID", "VOIDED", "DELETED", "SENDING", XERO_UNCONFIRMED];
/** One request at a time, capped per press — Xero allows 60 calls a minute. Each press moves on (xeroCheckedAt). */
const REFRESH_ALL_CAP = 25;

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
        where: {
          tenantId,
          status: "accepted",
          deletedAt: null,
          supersededAt: null,
          xeroInvoiceId: { not: null },
          OR: [{ xeroStatus: { notIn: REFRESH_ALL_SKIPS } }, { xeroStatus: "PAID", xeroAmountPaidCents: null }],
          ...(accessible === null ? {} : { id: { in: accessible } }),
        },
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

/**
 * Refresh ONE invoice from Xero — Xero's number, status and total; its newest PDF
 * when it moved on (or none is filed yet); and its payments, brought back into the
 * CRM (syncPaymentsFromXero). Refuses (ActionRefusal) or throws Xero's error;
 * the callers say it.
 */
async function refreshOneFromXero(
  client: XeroClient,
  tenantId: string,
  quoteId: string,
  user: PermissionUser,
): Promise<{ message: string; paymentsSaid: boolean }> {
  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, tenantId },
    select: { id: true, number: true, contactId: true, currency: true, xeroInvoiceId: true, xeroInvoiceNumber: true, xeroStatus: true },
  });
  if (!quote) refuse(QUOTE_GONE);
  if (!quote.xeroInvoiceId) refuse(`Q-${quote.number} has not been sent to Xero yet.`);
  // Mid-send or unfinished: the linked invoice is the voided one being replaced —
  // Refresh would only read that back. Send settles it.
  if (xeroSendUncertain(quote.xeroStatus)) refuse("A send to Xero is in progress or didn't finish — press Send invoice to Xero to settle it.");
  const invoice = await client.getInvoice(quote.xeroInvoiceId);
  const updated = await prisma.quote.updateMany({
    // Only the state that was read: a send that claimed it meanwhile keeps its claim.
    where: { id: quoteId, tenantId, xeroInvoiceId: quote.xeroInvoiceId, xeroStatus: quote.xeroStatus },
    data: { xeroInvoiceNumber: invoice.number, xeroStatus: invoice.status, xeroTotalCents: invoice.totalCents },
  });
  // Nothing matched: a send took it over, or Xero was reconnected to another
  // organisation meanwhile — stop here; nothing from this read is kept or filed.
  if (updated.count !== 1) refuse("This invoice changed while it was being refreshed (a send, or Xero was reconnected) — reload the page.");
  revalidatePath("/deliveries");
  revalidatePath("/invoices");
  if (quote.contactId) revalidatePath(`/contacts/${quote.contactId}`);
  if (xeroInvoiceCancelled(invoice.status)) {
    // Voided in Xero: the CRM invoice is free again (xeroLockReason). No PDF of a voided invoice is filed.
    if (quote.xeroStatus !== invoice.status) await logAudit({ action: "quote.xero_voided", summary: `Q-${quote.number}: Xero invoice ${invoice.number ?? invoice.id} is ${xeroStatusLabel(invoice.status).toLowerCase()} in Xero — unlocked in the CRM`, contactId: quote.contactId, user });
    return { message: `Xero: ${invoice.number ?? "invoice"} · ${xeroStatusLabel(invoice.status)}. This invoice can be changed in the CRM again, or sent to Xero again.`, paymentsSaid: false };
  }
  // An invoice linked to Xero BEFORE sending marked it invoiced (#1071) has no
  // invoice date, so it would sit in "Awaiting payment" and never take a deposit.
  // A live Xero invoice IS the invoice: mark it — never over an existing date, and
  // only while the quote still links THIS Xero invoice (review of #1071).
  const marked = await prisma.quote.updateMany({
    where: { id: quoteId, tenantId, xeroInvoiceId: invoice.id, invoicedAt: null },
    data: { invoicedAt: new Date() },
  });
  if (marked.count === 1) {
    await logAudit({ action: "fulfilment.invoiced", summary: `Q-${quote.number} invoiced — in Xero as ${invoice.number ?? "an invoice"}`, contactId: quote.contactId, user });
  }
  const changed = invoice.status !== quote.xeroStatus || invoice.number !== quote.xeroInvoiceNumber;
  const filed = await prisma.document.count({ where: { tenantId, quoteId, tag: "accounting-invoice", deletedAt: null } });
  const pdfFiled = changed || filed === 0 ? await tryFilePdf(client, { tenantId, quote, invoice, user }) : false;
  const fromXero = await syncPaymentsFromXero({ tenantId, quoteId, invoice, user });
  return {
    message: [`Xero: ${invoice.number ?? "invoice"} · ${xeroStatusLabel(invoice.status)}${pdfFiled ? " — latest PDF filed on the customer." : ""}`, fromXero ?? ""]
      .filter(Boolean)
      .join(" "),
    paymentsSaid: Boolean(fromXero),
  };
}
