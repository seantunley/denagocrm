"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addDays } from "date-fns";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { softDeleteRecord } from "@/lib/trash";
import { parseRands, formatZAR } from "@/lib/format";

/** Creates a draft quote from a lead, pre-filled with its product line. */
export async function createQuoteFromLead(leadId: string) {
  const user = await requireUser();
  const lead = await prisma.lead.findUniqueOrThrow({
    where: { id: leadId },
    include: { product: true },
  });
  const max = await prisma.quote.aggregate({ _max: { number: true } });
  const quote = await prisma.quote.create({
    data: {
      number: (max._max.number ?? 1000) + 1,
      leadId,
      contactId: lead.contactId,
      createdById: user.id,
      validUntil: addDays(new Date(), 14),
      terms: "Prices include VAT. Delivery arranged on acceptance. E&OE.",
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
    summary: `Created quote #${quote.number} for lead “${lead.title}”`,
    leadId,
    contactId: lead.contactId,
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

export async function setQuoteStatus(quoteId: string, status: string) {
  const user = await requireUser();
  const quote = await prisma.quote.update({
    where: { id: quoteId },
    data: { status },
    include: { items: true, lead: true },
  });
  const total = quote.items.reduce((s, i) => s + i.qty * i.unitPriceCents, 0);
  await logAudit({
    action: `quote.${status}`,
    summary: `Quote #${quote.number} (${formatZAR(Math.round(total))}) marked ${status}`,
    leadId: quote.leadId,
    contactId: quote.contactId,
    user,
  });
  // Accepting a quote wins its lead
  if (status === "accepted" && quote.leadId && quote.lead?.status === "open") {
    await prisma.lead.update({ where: { id: quote.leadId }, data: { status: "won" } });
    await logAudit({
      action: "lead.won",
      summary: `Lead “${quote.lead.title}” won via accepted quote #${quote.number} 🎉`,
      leadId: quote.leadId,
      contactId: quote.contactId,
      user,
    });
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
    summary: `Moved quote #${quote.number} to trash — ${reason}`,
    leadId: quote.leadId,
    contactId: quote.contactId,
    user,
  });
  revalidatePath("/quotes");
  redirect("/quotes");
}
