"use server";

import { revalidatePath } from "next/cache";
import { asActionResult, refuse } from "@/lib/actionResult";
import { actingTenantId } from "@/lib/actingTenant";
import { prisma } from "@/lib/db";
import { requireQuoteAccess } from "@/lib/permissions";
import { GOVERNANCE_TX, logAuditStrict } from "@/lib/audit";
import { formatZAR, parseRands } from "@/lib/format";
import { getRegionalSettings } from "@/lib/settings";
import { QUOTE_GONE } from "@/lib/quoteDelivery";
import {
  isPaymentMethod,
  isStatementInvoice,
  outstandingCents,
  paymentMethodLabel,
  statementInvoiceLabel,
} from "@/lib/accountStatement";

/*
 * Payments received against an invoice after its deposit (customer statements,
 * 2026-10-28). The deposit itself is still recorded on the deliveries board
 * (fulfilment.ts); these are the part-payments and final balance that follow.
 *
 * Same grant as recording the deposit — "deliveries.manage" — so the people who
 * take the deposit take the rest of the money. NOT gated on the automotive
 * module: any workspace that invoices gets paid.
 */

const MAX_REFERENCE = 120;
const MAX_NOTE = 500;

function text(formData: FormData, name: string, max: number): string | null {
  const value = String(formData.get(name) ?? "").trim();
  return value ? value.slice(0, max) : null;
}

/** The day the money arrived, as YYYY-MM-DD in the workspace's time zone. Never in the future. */
function receivedDate(raw: FormDataEntryValue | null, timeZone: string): Date {
  const value = String(raw ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) refuse("Enter the date the payment was received.");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  if (value > today) refuse("The payment date cannot be in the future.");
  if (value < "2000-01-01") refuse("Check the payment date.");
  // Midday UTC: the same calendar day in every time zone a workspace runs in.
  const date = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) refuse("Enter the date the payment was received.");
  return date;
}

function refreshPaths(quoteId: string) {
  revalidatePath(`/deals/${quoteId}`);
  revalidatePath(`/quotes/${quoteId}`);
  revalidatePath("/deliveries");
}

/**
 * Record money received against an accepted quote's invoice. Refuses more than
 * is still owing — a slipped zero must not put an account into credit — with the
 * quote locked so two people recording at once cannot both pass that check.
 */
export async function recordQuotePayment(quoteId: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireQuoteAccess(quoteId, "deliveries.manage");
    const tenantId = await actingTenantId();
    const regional = await getRegionalSettings();

    const rawAmount = String(formData.get("amount") ?? "").trim();
    if (!rawAmount) refuse("Enter the amount received.");
    const amountCents = parseRands(rawAmount);
    if (amountCents <= 0) refuse("The amount must be more than zero.");
    const method = String(formData.get("method") ?? "");
    if (!isPaymentMethod(method)) refuse("Choose how the payment was made.");
    const receivedAt = receivedDate(formData.get("receivedAt"), regional.timeZone);
    const reference = text(formData, "reference", MAX_REFERENCE);
    const note = text(formData, "note", MAX_NOTE);

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Quote" WHERE id = ${quoteId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      const quote = await tx.quote.findFirst({
        where: { id: quoteId, tenantId },
        include: { items: true, fees: true },
      });
      if (!quote) refuse(QUOTE_GONE);
      if (!isStatementInvoice(quote)) refuse("Payments can only be recorded against an accepted quote.");
      const existing = await tx.quotePayment.findMany({ where: { quoteId, tenantId } });
      const owing = outstandingCents(quote, existing);
      if (owing <= 0) refuse("Nothing is owing on this invoice.");
      if (amountCents > owing) refuse(`That is more than the ${formatZAR(owing, regional)} still owing on this invoice.`);

      const payment = await tx.quotePayment.create({
        data: {
          // The QUOTE's workspace, verbatim — the payment is the invoice's, not the clerk's.
          tenantId: quote.tenantId ?? tenantId,
          quoteId,
          amountCents,
          receivedAt,
          method,
          reference,
          note,
          createdById: user.id,
          createdByName: user.name,
        },
      });
      const label = statementInvoiceLabel(quote);
      await logAuditStrict(
        {
          action: "payment.recorded",
          summary: `${label} payment of ${formatZAR(amountCents, regional)} received (${paymentMethodLabel(method)}${reference ? ` · ${reference}` : ""}) — ${formatZAR(owing - amountCents, regional)} still owing`,
          contactId: quote.contactId,
          leadId: quote.leadId,
          user,
          entityType: "QuotePayment",
          entityId: payment.id,
          after: { quoteId, amountCents, receivedAt: receivedAt.toISOString(), method, reference, owingBeforeCents: owing },
        },
        tx,
      );
    }, GOVERNANCE_TX);

    refreshPaths(quoteId);
    return { success: "Payment recorded" };
  });
}

/** Void a payment recorded in error. Kept on the record with who, when and why; it stops counting. */
export async function voidQuotePayment(quoteId: string, paymentId: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireQuoteAccess(quoteId, "deliveries.manage");
    const tenantId = await actingTenantId();
    const regional = await getRegionalSettings();
    const reason = text(formData, "reason", MAX_NOTE);
    if (!reason || reason.length < 3) refuse("Say why this payment is being voided.");

    await prisma.$transaction(async (tx) => {
      const payment = await tx.quotePayment.findFirst({ where: { id: paymentId, quoteId, tenantId } });
      if (!payment) refuse("That payment is no longer available.");
      if (payment.voidedAt) refuse("That payment has already been voided.");
      const quote = await tx.quote.findFirst({ where: { id: quoteId, tenantId }, select: { number: true, invoiceNumber: true, contactId: true, leadId: true } });
      if (!quote) refuse(QUOTE_GONE);
      const voided = await tx.quotePayment.updateMany({
        where: { id: paymentId, quoteId, tenantId, voidedAt: null },
        data: { voidedAt: new Date(), voidedByName: user.name, voidReason: reason },
      });
      if (voided.count !== 1) refuse("That payment changed while you were editing. Refresh and try again.");
      await logAuditStrict(
        {
          action: "payment.voided",
          summary: `${statementInvoiceLabel(quote)} payment of ${formatZAR(payment.amountCents, regional)} voided — ${reason}`,
          contactId: quote.contactId,
          leadId: quote.leadId,
          user,
          entityType: "QuotePayment",
          entityId: payment.id,
          before: { voidedAt: null },
          after: { voidedAt: new Date().toISOString(), voidReason: reason },
        },
        tx,
      );
    }, GOVERNANCE_TX);

    refreshPaths(quoteId);
    return { success: "Payment voided" };
  });
}
