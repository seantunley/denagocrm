"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addDays } from "date-fns";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { softDeleteRecord } from "@/lib/trash";
import { getSetting } from "@/lib/settings";
import { parseRands, formatZAR, contactName } from "@/lib/format";

/** Creates a draft quote from a lead, pre-filled with its product line. */
export async function createQuoteFromLead(leadId: string) {
  const user = await requireUser();
  const lead = await prisma.lead.findUniqueOrThrow({
    where: { id: leadId },
    include: { product: true },
  });
  const max = await prisma.quote.aggregate({ _max: { number: true } });
  const validDaysRaw = await getSetting("QUOTE_VALID_DAYS");
  const validDays = validDaysRaw ? parseInt(validDaysRaw, 10) : 7;
  const terms =
    (await getSetting("QUOTE_TERMS")) ||
    "Prices include VAT. Delivery arranged on acceptance. E&OE.";
  const quote = await prisma.quote.create({
    data: {
      number: (max._max.number ?? 1000) + 1,
      leadId,
      contactId: lead.contactId,
      createdById: user.id,
      validUntil: addDays(new Date(), isNaN(validDays) ? 7 : validDays),
      terms,
      items: lead.product
        ? {
            create: [
              {
                description: `${lead.product.name}${lead.color ? ` — ${lead.color}` : ""}`,
                qty: 1,
                unitPriceCents: lead.valueCents || lead.product.basePriceCents,
              },
            ],
          }
        : undefined,
    },
  });
  await logAudit({
    action: "quote.created",
    summary: `Created quote Q-${quote.number} for lead “${lead.title}”`,
    leadId,
    contactId: lead.contactId,
    user,
  });
  revalidatePath("/quotes");
  redirect(`/quotes/${quote.id}`);
}

/** Creates a quote directly for an existing customer (no lead needed). */
export async function createQuoteForContact(formData: FormData) {
  const user = await requireUser();
  const contactId = String(formData.get("contactId") ?? "").trim();
  const productId = String(formData.get("productId") ?? "").trim() || null;
  if (!contactId) throw new Error("Customer is required");

  const product = productId
    ? await prisma.product.findUnique({ where: { id: productId } })
    : null;
  const max = await prisma.quote.aggregate({ _max: { number: true } });
  const validDaysRaw = await getSetting("QUOTE_VALID_DAYS");
  const validDays = validDaysRaw ? parseInt(validDaysRaw, 10) : 7;
  const terms =
    (await getSetting("QUOTE_TERMS")) ||
    "Prices include VAT. Delivery arranged on acceptance. E&OE.";
  const quote = await prisma.quote.create({
    data: {
      number: (max._max.number ?? 1000) + 1,
      contactId,
      createdById: user.id,
      validUntil: addDays(new Date(), isNaN(validDays) ? 7 : validDays),
      terms,
      items: product
        ? {
            create: [
              { description: product.name, qty: 1, unitPriceCents: product.basePriceCents },
            ],
          }
        : undefined,
    },
    include: { contact: true },
  });
  await logAudit({
    action: "quote.created",
    summary: `Created quote Q-${quote.number} for ${quote.contact ? contactName(quote.contact) : "customer"}`,
    contactId,
    user,
  });
  revalidatePath("/quotes");
  redirect(`/quotes/${quote.id}`);
}

export async function addQuoteItem(quoteId: string, formData: FormData) {
  await requireUser();
  const description = String(formData.get("description") ?? "").trim();
  if (!description) return;
  await prisma.quoteItem.create({
    data: {
      quoteId,
      description,
      qty: parseFloat(String(formData.get("qty") ?? "1")) || 1,
      unitPriceCents: parseRands(String(formData.get("unitPrice") ?? "")),
    },
  });
  revalidatePath(`/quotes/${quoteId}`);
}

export async function deleteQuoteItem(id: string, quoteId: string, formData: FormData) {
  await requireUser();
  void formData;
  await prisma.quoteItem.delete({ where: { id } });
  revalidatePath(`/quotes/${quoteId}`);
}

export async function updateQuoteMeta(quoteId: string, formData: FormData) {
  await requireUser();
  const validUntilRaw = String(formData.get("validUntil") ?? "").trim();
  await prisma.quote.update({
    where: { id: quoteId },
    data: {
      validUntil: validUntilRaw ? new Date(validUntilRaw) : null,
      terms: String(formData.get("terms") ?? "").trim() || null,
    },
  });
  revalidatePath(`/quotes/${quoteId}`);
}

/**
 * A lead only stays "won" while a live accepted quote backs it up. If the
 * accepted quote is deleted or reverted, the sale never happened — reopen the
 * lead so reports don't count it.
 */
async function reopenLeadIfNoAcceptedQuote(
  leadId: string,
  quoteNumber: number,
  user: Awaited<ReturnType<typeof requireUser>>
) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead || lead.status !== "won") return;
  const stillAccepted = await prisma.quote.count({
    where: { leadId, status: "accepted" },
  });
  if (stillAccepted > 0) return;
  await prisma.lead.update({ where: { id: leadId }, data: { status: "open" } });
  await logAudit({
    action: "lead.reopened",
    summary: `Lead “${lead.title}” reopened — quote Q-${quoteNumber} is no longer accepted, so it doesn't count as a sale`,
    leadId,
    contactId: lead.contactId,
    user,
  });
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
  revalidatePath("/reports");
}

export async function setQuoteStatus(quoteId: string, status: string) {
  const user = await requireUser();
  const before = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId } });
  const quote = await prisma.quote.update({
    where: { id: quoteId },
    data: { status },
    include: { items: true, lead: true },
  });
  const total = quote.items.reduce((s, i) => s + i.qty * i.unitPriceCents, 0);
  const verb =
    status === "sent"
      ? "sent to the customer"
      : status === "accepted"
      ? "accepted 🎉"
      : status === "declined"
      ? "declined"
      : "moved back to draft";
  await logAudit({
    action: `quote.${status}`,
    summary: `Quote Q-${quote.number} (${formatZAR(Math.round(total))}) ${verb}`,
    leadId: quote.leadId,
    contactId: quote.contactId,
    user,
  });
  // Accepting a quote wins its lead
  if (status === "accepted" && quote.leadId && quote.lead?.status === "open") {
    await prisma.lead.update({ where: { id: quote.leadId }, data: { status: "won" } });
    await logAudit({
      action: "lead.won",
      summary: `Lead “${quote.lead.title}” won via accepted quote Q-${quote.number} 🎉`,
      leadId: quote.leadId,
      contactId: quote.contactId,
      user,
    });
  }
  // Reverting an accepted quote un-wins the lead (unless another accepted quote backs it)
  if (before.status === "accepted" && status !== "accepted" && quote.leadId) {
    await reopenLeadIfNoAcceptedQuote(quote.leadId, quote.number, user);
  }
  revalidatePath("/quotes");
  revalidatePath(`/quotes/${quoteId}`);
  if (quote.leadId) revalidatePath(`/leads/${quote.leadId}`);
}

export async function deleteQuote(id: string, formData: FormData) {
  const user = await requireUser();
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  const quote = await softDeleteRecord("quote", id, reason, user.name);
  await logAudit({
    action: "trash.deleted",
    summary: `Moved quote Q-${quote.number} to trash — ${reason}`,
    leadId: quote.leadId,
    contactId: quote.contactId,
    user,
  });
  // Deleting an accepted quote means the sale is off — un-win the lead
  if (quote.status === "accepted" && quote.leadId) {
    await reopenLeadIfNoAcceptedQuote(quote.leadId, quote.number, user);
  }
  revalidatePath("/quotes");
  redirect("/quotes");
}
