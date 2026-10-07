import "server-only";
import type { Prisma } from "@prisma/client";
import { CLOSED_REQUEST_STATUSES } from "./signing/statusPolicy";
import { logAuditStrict } from "./audit";
import { markReferralEarned } from "./referrals";
import { emitLeadJourneyEvent } from "./leadJourneyEvents";
import { triggerSurvey } from "./surveys";
import { logError } from "./errorLog";
import { issueInvoiceNumberInTx, nextQuoteNumber } from "./numbering";
import { payableTotalCents } from "./pricing";
import { formatZAR } from "./format";

/**
 * WHAT HAPPENS TO A QUOTE WHEN THE DEAL IS DECIDED — one definition.
 *
 * "Mark won" and "accept the quote" used to be two features that never met.
 * Accepting a quote set it `accepted`, which is the only thing the Deliveries
 * board reads, and won the lead. Mark won only won the lead: the quote stayed
 * `sent`, so the deal never reached Deliveries and stock could never be
 * allocated to it (allocation requires an accepted quote).
 *
 * Both now go through {@link acceptQuoteInTx}. The signing hub's completion
 * reaches the same end state (accepted + lead won) in its own locked
 * transaction, because it also seals the signed PDF.
 *
 * Every function here takes the caller's transaction and the OWNING TENANT, and
 * names that tenant on every statement: these run on `basePrisma`, the RLS
 * bypass, where the predicate is the only boundary there is.
 */

type Tx = Prisma.TransactionClient;
type Actor = { id: string; name: string };
/** Only what a win touches, so the signing hub's extended-client transaction fits as well as a plain one. */
type LeadWinTx = {
  $executeRaw: Tx["$executeRaw"];
  lead: { updateMany(args: { where: Prisma.LeadWhereInput; data: Prisma.LeadUpdateManyMutationInput }): PromiseLike<{ count: number }> };
};

/** A quote in one of these can still be the one the customer accepted. */
export const WINNABLE_QUOTE_STATUSES = ["draft", "sent", "declined"];

/**
 * Lock the lead and move it open → won. True only when THIS call won it.
 *
 * `valueCents`: the accepted quote's total, when a quote is what won it. The
 * deal is worth what the customer accepted, not the estimate typed in when the
 * lead arrived — and the dashboard's "won value", targets and reports all sum
 * the LEAD's value. Without it, Q-1025 (R 242 000) won a lead worth R 0
 * (Sean, 2026-10-07: "why does dashboard show no won value?").
 */
export async function winLeadInTx(tx: LeadWinTx, leadId: string, tenantId: string, valueCents?: number): Promise<boolean> {
  await tx.$executeRaw`SELECT id FROM "Lead" WHERE id = ${leadId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  const won = await tx.lead.updateMany({
    where: { id: leadId, tenantId, deletedAt: null, status: "open" },
    data: { status: "won", ...(valueCents !== undefined ? { valueCents } : {}) },
  });
  return won.count === 1;
}

export type AcceptOutcome =
  | {
      kind: "accepted";
      quote: { id: string; number: number; leadId: string | null; contactId: string | null };
      /** Set only when this acceptance is what won the lead. */
      wonLeadId: string | null;
    }
  | { kind: "gone" }
  | { kind: "out_for_signature" };

/**
 * Accept a quote and win its lead, with both audits, in the caller's
 * transaction. Refuses (writes nothing) when the quote is trashed, superseded,
 * signed, cancelled, or has a live signing request — the customer is signing
 * it, so the answer is theirs to give.
 */
export async function acceptQuoteInTx(tx: Tx, quoteId: string, tenantId: string, actor: Actor): Promise<AcceptOutcome> {
  await tx.$executeRaw`SELECT id FROM "Quote" WHERE id = ${quoteId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  const before = await tx.quote.findFirst({
    where: { id: quoteId, tenantId },
    // fees: the audit records the value of the sale, fees and delivery included.
    include: { items: true, fees: true, lead: { select: { title: true, valueCents: true } } },
  });
  if (!before || before.deletedAt || before.signedAt || before.supersededAt || before.status === "cancelled") {
    return { kind: "gone" };
  }
  const liveRequest = await tx.signatureRequest.findFirst({
    where: { quoteId, tenantId, deletedAt: null, status: { notIn: [...CLOSED_REQUEST_STATUSES] } },
    select: { id: true },
  });
  if (liveRequest) return { kind: "out_for_signature" };

  const updated = await tx.quote.updateMany({ where: { id: quoteId, tenantId }, data: { status: "accepted" } });
  if (updated.count !== 1) return { kind: "gone" };
  // Accepted is when it becomes an invoice: it gets its own invoice number.
  await issueInvoiceNumberInTx(tx, quoteId, tenantId);
  const totalCents = Math.round(payableTotalCents(before));
  await logAuditStrict({
    action: "quote.accepted",
    summary: `Quote Q-${before.number} (${formatZAR(totalCents)}) accepted 🎉`,
    leadId: before.leadId,
    contactId: before.contactId,
    user: actor,
    before: { status: before.status },
    after: { status: "accepted" },
  }, tx);

  let wonLeadId: string | null = null;
  if (before.leadId && (await winLeadInTx(tx, before.leadId, tenantId, totalCents))) {
    wonLeadId = before.leadId;
    await logAuditStrict({
      action: "lead.won",
      summary: `Lead “${before.lead?.title ?? ""}” won via accepted quote Q-${before.number} (${formatZAR(totalCents)}) 🎉`,
      leadId: before.leadId,
      contactId: before.contactId,
      user: actor,
      before: { valueCents: before.lead?.valueCents ?? null },
      after: { status: "won", valueCents: totalCents },
      metadata: { quoteId },
    }, tx);
  }
  return {
    kind: "accepted",
    quote: { id: before.id, number: before.number, leadId: before.leadId, contactId: before.contactId },
    wonLeadId,
  };
}

/**
 * The effects of a win that live outside the database transaction, fired once,
 * only by the call that actually won the lead — whichever button produced it.
 */
export async function afterDealWon(leadId: string, contactId: string | null): Promise<void> {
  await markReferralEarned(leadId).catch(() => {});
  await emitLeadJourneyEvent("lead_won", leadId);
  if (contactId) {
    // The win is committed; a survey that cannot be queued must not report it as
    // failed. Logged by lead id only — no customer details.
    await triggerSurvey("won", { contactId, leadId }).catch((error) =>
      logError("deal.won.survey", error, `lead ${leadId}`),
    );
  }
}

export type CancelOutcome =
  | {
      kind: "cancelled";
      quote: { id: string; number: number; leadId: string | null; contactId: string | null };
      wasAccepted: boolean;
      voidedRequests: number;
      releasedUnits: Array<{ id: string; stockNumber: string | null; from: string; to: string; leadId: string | null }>;
    }
  | { kind: "refused"; message: string };

/**
 * Cancel a quote — including a signed one — without deleting anything.
 *
 * The signed PDF, the completed signing request and every audit row stay where
 * they are; the quote becomes `cancelled`, which drops it off Deliveries and out
 * of every "accepted" figure. A live signing request is voided so the customer's
 * link stops working, and stock allocated to the quote is released:
 * reserved/allocated units go back to `available`; a unit already in PDI, ready
 * or on hold goes to `hold`, unlinked, so somebody looks at it before it is sold
 * again. A handed-over unit or a delivered quote refuses — that is a return, not
 * a cancellation.
 *
 * Reopening the lead behind an accepted quote is the caller's job, in the same
 * transaction (see reopenLeadInTx in actions/quotes.ts).
 */
export async function cancelQuoteInTx(
  tx: Tx,
  input: { quoteId: string; tenantId: string; reason: string; actor: Actor },
): Promise<CancelOutcome> {
  const { quoteId, tenantId, reason, actor } = input;
  await tx.$executeRaw`SELECT id FROM "Quote" WHERE id = ${quoteId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  const quote = await tx.quote.findFirst({ where: { id: quoteId, tenantId } });
  if (!quote || quote.deletedAt) return { kind: "refused", message: "That quote is no longer available — reload the page." };
  if (quote.supersededAt) return { kind: "refused", message: "This version was superseded by a revision — cancel the current version instead." };
  if (quote.status === "cancelled") return { kind: "refused", message: `Quote Q-${quote.number} is already cancelled.` };
  if (quote.deliveredAt) return { kind: "refused", message: `Quote Q-${quote.number} has already been delivered, so it can't be cancelled.` };

  const units = await tx.stockUnit.findMany({
    where: { soldQuoteId: quoteId, tenantId, deletedAt: null },
    select: { id: true, status: true, stockNumber: true, reservedForLeadId: true },
  });
  if (units.some((unit) => unit.status === "delivered" || unit.status === "sold")) {
    return { kind: "refused", message: "A stock unit on this quote has already been handed over, so it can't be cancelled." };
  }

  const voided = await tx.signatureRequest.updateMany({
    where: { quoteId, tenantId, deletedAt: null, status: { notIn: [...CLOSED_REQUEST_STATUSES] } },
    data: { status: "voided" },
  });
  // signToken too: the legacy /sign link must stop working with the hub's.
  const updated = await tx.quote.updateMany({
    where: { id: quoteId, tenantId, status: quote.status },
    data: { status: "cancelled", signToken: null, signLinkCreatedAt: null, reminderSentAt: null },
  });
  if (updated.count !== 1) throw new Error("The quote changed while it was being cancelled.");

  const releasedUnits: Extract<CancelOutcome, { kind: "cancelled" }>["releasedUnits"] = [];
  for (const unit of units) {
    const to = unit.status === "reserved" || unit.status === "allocated" ? "available" : "hold";
    const released = await tx.stockUnit.updateMany({
      where: { id: unit.id, tenantId, soldQuoteId: quoteId, status: unit.status },
      data: { status: to, soldQuoteId: null, reservedForLeadId: null, soldAt: null },
    });
    if (released.count !== 1) throw new Error("A stock unit changed while the quote was being cancelled.");
    releasedUnits.push({ id: unit.id, stockNumber: unit.stockNumber, from: unit.status, to, leadId: unit.reservedForLeadId });
  }
  if (releasedUnits.length > 0) {
    await tx.stockReservation.updateMany({
      where: { stockUnitId: { in: releasedUnits.map((unit) => unit.id) }, tenantId, status: "active" },
      data: { status: "released", releasedAt: new Date(), releaseReason: `Quote Q-${quote.number} cancelled` },
    });
  }

  const extras = [
    quote.signedAt ? "signed copy kept" : null,
    voided.count > 0 ? "signing request voided" : null,
    releasedUnits.length > 0 ? `${releasedUnits.length} stock unit${releasedUnits.length === 1 ? "" : "s"} released` : null,
  ].filter(Boolean);
  await logAuditStrict({
    action: "quote.cancelled",
    summary: `Cancelled quote Q-${quote.number} — ${reason}${extras.length ? ` (${extras.join(", ")})` : ""}`,
    leadId: quote.leadId,
    contactId: quote.contactId,
    user: actor,
    before: { status: quote.status },
    after: { status: "cancelled" },
    metadata: {
      quoteId,
      reason,
      signed: Boolean(quote.signedAt),
      voidedSigningRequests: voided.count,
      releasedStockUnitIds: releasedUnits.map((unit) => unit.id),
    },
  }, tx);

  return {
    kind: "cancelled",
    quote: { id: quote.id, number: quote.number, leadId: quote.leadId, contactId: quote.contactId },
    wasAccepted: quote.status === "accepted",
    voidedRequests: voided.count,
    releasedUnits,
  };
}

/**
 * A new DRAFT copy of a quote: new number, same customer, lead, account, lines,
 * fees, terms and custom fields — and none of the original's signing or
 * fulfilment state. Unlike a revision it supersedes nothing, so it works on a
 * signed or cancelled quote, which is exactly when it is needed.
 */
export async function duplicateQuoteInTx(
  tx: Tx,
  input: { quoteId: string; tenantId: string; actor: Actor; validUntil: Date },
): Promise<{ id: string; number: number; originalNumber: number; leadId: string | null; contactId: string | null } | null> {
  const { quoteId, tenantId, actor, validUntil } = input;
  const original = await tx.quote.findFirst({
    where: { id: quoteId, tenantId, deletedAt: null },
    include: { items: true, fees: true },
  });
  if (!original) return null;

  const number = await nextQuoteNumber(tx);
  const created = await tx.quote.create({
    data: {
      number,
      tenantId,
      status: "draft",
      contactId: original.contactId,
      leadId: original.leadId,
      fleetId: original.fleetId,
      createdById: actor.id,
      validUntil,
      terms: original.terms,
      taxInclusive: original.taxInclusive,
      depositType: original.depositType,
      depositValue: original.depositValue,
      items: {
        create: original.items.map((item) => ({
          tenantId,
          description: item.description,
          qty: item.qty,
          unitPriceCents: item.unitPriceCents,
          discountPct: item.discountPct,
          colorPreference: item.colorPreference,
          kind: item.kind,
          taxRatePct: item.taxRatePct,
          costCents: item.costCents,
          optional: item.optional,
          selected: item.selected,
          sortOrder: item.sortOrder,
          productId: item.productId,
        })),
      },
      fees: {
        create: original.fees.map((fee) => ({
          tenantId,
          label: fee.label,
          kind: fee.kind,
          amountCents: fee.amountCents,
          taxRatePct: fee.taxRatePct,
          sortOrder: fee.sortOrder,
        })),
      },
    },
    select: { id: true, number: true },
  });
  const customValues = await tx.customFieldValue.findMany({
    where: { recordId: original.id, tenantId, def: { entity: "quote" } },
    select: { defId: true, value: true },
  });
  if (customValues.length > 0) {
    await tx.customFieldValue.createMany({
      data: customValues.map((value) => ({ defId: value.defId, recordId: created.id, value: value.value, tenantId })),
    });
  }
  await logAuditStrict({
    action: "quote.created",
    summary: `Created quote Q-${created.number} as a copy of Q-${original.number}`,
    leadId: original.leadId,
    contactId: original.contactId,
    user: actor,
    metadata: { quoteId: created.id, duplicatedFromQuoteId: original.id },
  }, tx);
  return { id: created.id, number: created.number, originalNumber: original.number, leadId: original.leadId, contactId: original.contactId };
}
