"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireQuoteAccess } from "@/lib/permissions";
import { parseRands } from "@/lib/format";

function revalidateQuote(quoteId: string) {
  revalidatePath(`/quotes/${quoteId}`);
  revalidatePath("/quotes");
}

// ── Fees & delivery charges ───────────────────────────────────────────────────
export async function addQuoteFee(quoteId: string, formData: FormData) {
  await requireQuoteAccess(quoteId, "quotes.edit");
  const label = String(formData.get("label") ?? "").trim();
  if (!label) return;
  const kind = String(formData.get("kind") ?? "fee") === "delivery" ? "delivery" : "fee";
  const amountCents = parseRands(String(formData.get("amount") ?? ""));
  const taxRatePct = Number.parseFloat(String(formData.get("taxRatePct") ?? "15"));
  const max = await prisma.quoteFee.aggregate({ where: { quoteId }, _max: { sortOrder: true } });
  await prisma.quoteFee.create({
    data: { quoteId, label, kind, amountCents, taxRatePct: Number.isFinite(taxRatePct) ? taxRatePct : 15, sortOrder: (max._max.sortOrder ?? 0) + 1 },
  });
  revalidateQuote(quoteId);
}

export async function deleteQuoteFee(feeId: string, quoteId: string) {
  await requireQuoteAccess(quoteId, "quotes.edit");
  await prisma.quoteFee.delete({ where: { id: feeId } }).catch(() => {});
  revalidateQuote(quoteId);
}

// ── Deposit terms ─────────────────────────────────────────────────────────────
export async function setQuoteDeposit(quoteId: string, formData: FormData) {
  await requireQuoteAccess(quoteId, "quotes.edit");
  const type = String(formData.get("depositType") ?? "").trim();
  const depositType = type === "percent" || type === "amount" ? type : null;
  const raw = String(formData.get("depositValue") ?? "").trim();
  const depositValue = depositType === null || raw === "" ? null : Math.max(0, Number.parseFloat(raw) || 0);
  await prisma.quote.update({ where: { id: quoteId }, data: { depositType, depositValue } });
  revalidateQuote(quoteId);
}

// ── Tax mode ──────────────────────────────────────────────────────────────────
export async function setQuoteTaxMode(quoteId: string, formData: FormData) {
  await requireQuoteAccess(quoteId, "quotes.edit");
  const taxInclusive = String(formData.get("taxInclusive") ?? "true") === "true";
  await prisma.quote.update({ where: { id: quoteId }, data: { taxInclusive } });
  revalidateQuote(quoteId);
}
