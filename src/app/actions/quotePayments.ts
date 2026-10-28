"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { asActionResult, refuse } from "@/lib/actionResult";
import { actingTenantId } from "@/lib/actingTenant";
import { prisma } from "@/lib/db";
import { requireQuoteAccess } from "@/lib/permissions";
import { GOVERNANCE_TX, logAuditStrict } from "@/lib/audit";
import { formatZAR } from "@/lib/format";
import { parseMoneyInput } from "@/lib/moneyInput";
import { getRegionalSettings } from "@/lib/settings";
import { isPaymentMethod, paymentMethodLabel, statementInvoiceLabel } from "@/lib/accountStatement";
import { recordPaymentInTx, voidPaymentInTx } from "@/lib/quoteLedger";

/*
 * Payments received against an invoice after its deposit (customer statements,
 * 2026-10-28). The deposit itself is still recorded on the deliveries board
 * (fulfilment.ts); these are the part-payments and final balance that follow.
 * Both go through lib/quoteLedger.ts, under one quote-row lock, so neither can
 * take an invoice past paid.
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
 * is still owing after the deposit and earlier payments; a resubmitted form
 * returns the payment it already recorded rather than recording it twice.
 */
export async function recordQuotePayment(quoteId: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireQuoteAccess(quoteId, "deliveries.manage");
    const tenantId = await actingTenantId();
    const regional = await getRegionalSettings();
    const money = (cents: number) => formatZAR(cents, regional);

    const amount = parseMoneyInput(String(formData.get("amount") ?? ""));
    if (!amount.ok) refuse(amount.error);
    const amountCents = amount.cents;
    if (amountCents <= 0) refuse("The amount must be more than zero.");
    const method = String(formData.get("method") ?? "");
    if (!isPaymentMethod(method)) refuse("Choose how the payment was made.");
    const receivedAt = receivedDate(formData.get("receivedAt"), regional.timeZone);
    const reference = text(formData, "reference", MAX_REFERENCE);
    const note = text(formData, "note", MAX_NOTE);
    const idempotencyKey = String(formData.get("idempotencyKey") ?? "");

    let duplicate = false;
    try {
      await prisma.$transaction(async (tx) => {
        const result = await recordPaymentInTx(
          tx,
          { quoteId, tenantId, amountCents, receivedAt, method, reference, note, idempotencyKey, createdById: user.id, createdByName: user.name },
          money,
        );
        // A resubmission records nothing new, so it audits nothing new either.
        duplicate = result.kind === "duplicate";
        if (result.kind === "recorded") {
          const { ledger, payment } = result;
          await logAuditStrict(
            {
              action: "payment.recorded",
              summary: `${statementInvoiceLabel(ledger.quote)} payment of ${money(amountCents)} received (${paymentMethodLabel(method)}${reference ? ` · ${reference}` : ""}) — ${money(ledger.owingCents - amountCents)} still owing`,
              contactId: ledger.quote.contactId,
              leadId: ledger.quote.leadId,
              user,
              entityType: "QuotePayment",
              entityId: payment.id,
              after: { quoteId, amountCents, receivedAt: receivedAt.toISOString(), method, reference, owingBeforeCents: ledger.owingCents },
            },
            tx,
          );
        }
      }, GOVERNANCE_TX);
    } catch (error) {
      // The unique (tenantId, idempotencyKey) index: the same form, committed by
      // a request that ran at the same instant. It is recorded — once.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") duplicate = true;
      else throw error;
    }

    refreshPaths(quoteId);
    return { success: duplicate ? "That payment was already recorded" : "Payment recorded" };
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
      const { payment, ledger } = await voidPaymentInTx(tx, { quoteId, tenantId, paymentId, reason, voidedByName: user.name });
      await logAuditStrict(
        {
          action: "payment.voided",
          summary: `${statementInvoiceLabel(ledger.quote)} payment of ${formatZAR(payment.amountCents, regional)} voided — ${reason}`,
          contactId: ledger.quote.contactId,
          leadId: ledger.quote.leadId,
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
