"use server";

import { asActionResult, refuse } from "@/lib/actionResult";
import { revalidatePath } from "next/cache";
import { requireQuoteAccess } from "@/lib/permissions";
import { withEditableQuote } from "@/lib/quoteLock";
import { parseRands } from "@/lib/format";

function revalidateQuote(quoteId: string) {
  revalidatePath(`/quotes/${quoteId}`);
  revalidatePath("/quotes");
}

// ── Fees & delivery charges ───────────────────────────────────────────────────
export async function addQuoteFee(quoteId: string, formData: FormData) {
  return asActionResult(async () => {
    await requireQuoteAccess(quoteId, "quotes.edit");
    const label = String(formData.get("label") ?? "").trim();
    if (!label) refuse("Give the fee a label.");
    const kind = String(formData.get("kind") ?? "fee") === "delivery" ? "delivery" : "fee";
    const amountCents = parseRands(String(formData.get("amount") ?? ""));
    const taxRatePct = Number.parseFloat(String(formData.get("taxRatePct") ?? "15"));
    // Lock the quote FOR UPDATE and re-check editability inside the transaction so
    // a concurrent send/sign/revision can't be edited under the customer (TOCTOU).
    // The sortOrder aggregate runs under the same lock, so two adds can't collide.
    await withEditableQuote(quoteId, async (tx) => {
      const max = await tx.quoteFee.aggregate({ where: { quoteId }, _max: { sortOrder: true } });
      await tx.quoteFee.create({
        data: { quoteId, label, kind, amountCents, taxRatePct: Number.isFinite(taxRatePct) ? taxRatePct : 15, sortOrder: (max._max.sortOrder ?? 0) + 1 },
      });
    });
    revalidateQuote(quoteId);
  });
}

export async function deleteQuoteFee(feeId: string, quoteId: string) {
  return asActionResult(async () => {
    await requireQuoteAccess(quoteId, "quotes.edit");
    // Scope to the authorized quote (deleting by feeId alone let a user with edit
    // access to their own quote delete a fee off someone else's quote) AND hold the
    // editability lock for the delete.
    await withEditableQuote(quoteId, async (tx) => {
      await tx.quoteFee.deleteMany({ where: { id: feeId, quoteId } });
    });
    revalidateQuote(quoteId);
  });
}

// ── Deposit terms ─────────────────────────────────────────────────────────────
export async function setQuoteDeposit(quoteId: string, formData: FormData) {
  return asActionResult(async () => {
    await requireQuoteAccess(quoteId, "quotes.edit");
    const type = String(formData.get("depositType") ?? "").trim();
    const depositType = type === "percent" || type === "amount" ? type : null;
    const raw = String(formData.get("depositValue") ?? "").trim();
    const depositValue = depositType === null || raw === "" ? null : Math.max(0, Number.parseFloat(raw) || 0);
    await withEditableQuote(quoteId, async (tx) => {
      await tx.quote.update({ where: { id: quoteId }, data: { depositType, depositValue } });
    });
    revalidateQuote(quoteId);
  });
}

// ── Tax mode ──────────────────────────────────────────────────────────────────
export async function setQuoteTaxMode(quoteId: string, formData: FormData) {
  return asActionResult(async () => {
    await requireQuoteAccess(quoteId, "quotes.edit");
    const taxInclusive = String(formData.get("taxInclusive") ?? "true") === "true";
    await withEditableQuote(quoteId, async (tx) => {
      await tx.quote.update({ where: { id: quoteId }, data: { taxInclusive } });
    });
    revalidateQuote(quoteId);
  });
}
