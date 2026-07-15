"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addDays } from "date-fns";
import { prisma, basePrisma } from "@/lib/db";
import { quoteTotalCents } from "@/lib/pricing";
import { logAudit } from "@/lib/audit";
import { softDeleteRecord } from "@/lib/trash";
import { getSetting } from "@/lib/settings";
import { markReferralEarned } from "@/lib/referrals";
import { runLeadAutomations } from "@/lib/automations";
import { parseRands, formatZAR, contactName } from "@/lib/format";
import { z } from "zod";
import {
  requireLeadAccess,
  requireContactAccess,
  requireQuoteAccess,
  type PermissionUser,
} from "@/lib/permissions";

const quoteDraftSchema = z.object({
  id: z.string().trim().min(1).optional(),
  contactId: z.string().trim().min(1, "Select a customer."),
  validUntil: z.string().trim().max(10).nullable().optional(),
  terms: z.string().trim().max(10_000, "Terms are too long."),
  intent: z.enum(["draft", "sent"]),
  items: z.array(
    z.object({
      description: z.string().trim().min(1, "Every line needs a description.").max(500),
      qty: z.number().finite().positive().max(100_000),
      unitPriceCents: z.number().int().min(0).max(100_000_000_000),
      productId: z.string().trim().min(1).nullable().optional(),
      colorPreference: z.string().trim().max(100).nullable().optional(),
      discountPct: z.number().finite().min(0).max(100).optional(),
      taxRatePct: z.number().finite().min(0).max(100).optional(),
    }),
  ).max(100, "A quote can contain at most 100 lines."),
  // CPQ
  taxInclusive: z.boolean().optional(),
  depositType: z.enum(["percent", "amount"]).nullable().optional(),
  depositValue: z.number().finite().min(0).nullable().optional(),
  fees: z.array(
    z.object({
      label: z.string().trim().min(1).max(120),
      kind: z.enum(["fee", "delivery"]).optional(),
      amountCents: z.number().int(),
      taxRatePct: z.number().finite().min(0).max(100).optional(),
    }),
  ).max(20).optional(),
});

export type QuoteDraftInput = z.input<typeof quoteDraftSchema>;

export type QuoteDraftResult =
  | {
      ok: true;
      quote: {
        id: string;
        number: number;
        status: string;
        updatedAt: string;
      };
    }
  | { ok: false; error: string };

/** Creates a draft quote from a lead, pre-filled with its product line. */
async function createQuoteFromLeadRecord(leadId: string) {
  const user = await requireLeadAccess(leadId, "quotes.create");
  const lead = await prisma.lead.findUniqueOrThrow({
    where: { id: leadId },
    include: { product: true },
  });
  const max = await basePrisma.quote.aggregate({ _max: { number: true } });
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
                description: lead.product.name,
                qty: 1,
                unitPriceCents: lead.valueCents || lead.product.basePriceCents,
                productId: lead.product.id,
                colorPreference: lead.color || null,
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
  return quote;
}

export async function createQuoteFromLead(leadId: string) {
  const quote = await createQuoteFromLeadRecord(leadId);
  redirect(`/quotes/${quote.id}`);
}

export async function createQuoteFromLeadInEditor(leadId: string) {
  const quote = await createQuoteFromLeadRecord(leadId);
  redirect(`/quotes?edit=${quote.id}`);
}

/** Creates a quote directly for an existing customer (no lead needed). */
export async function createQuoteForContact(formData: FormData) {
  const contactId = String(formData.get("contactId") ?? "").trim();
  const productId = String(formData.get("productId") ?? "").trim() || null;
  if (!contactId) throw new Error("Customer is required");
  const user = await requireContactAccess(contactId, "quotes.create");

  const product = productId
    ? await prisma.product.findUnique({ where: { id: productId } })
    : null;
  const max = await basePrisma.quote.aggregate({ _max: { number: true } });
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
              {
                description: product.name,
                qty: 1,
                unitPriceCents: product.basePriceCents,
                productId: product.id,
              },
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

/**
 * Creates or atomically updates a quote draft for the modal editor. The client
 * supplies only editable fields; identity, locking state and quote numbering
 * are always resolved again on the server.
 */
export async function saveQuoteDraft(input: QuoteDraftInput): Promise<QuoteDraftResult> {
  const parsed = quoteDraftSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the quote details." };
  }

  const data = parsed.data;
  // RBAC: editing an existing draft needs quote access; a new quote needs contact access.
  const user = data.id
    ? await requireQuoteAccess(data.id, "quotes.edit")
    : await requireContactAccess(data.contactId, "quotes.create");
  if (data.intent === "sent" && data.items.length === 0) {
    return { ok: false, error: "Add at least one line before marking the quote as sent." };
  }

  const productIds = [...new Set(data.items.flatMap((item) => item.productId ? [item.productId] : []))];
  const products = productIds.length > 0
    ? await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, colors: { select: { name: true } } },
      })
    : [];
  const productsById = new Map(products.map((product) => [product.id, product]));
  const normalizedItems: Array<{
    description: string;
    qty: number;
    unitPriceCents: number;
    productId: string | null;
    colorPreference: string | null;
    discountPct: number;
    taxRatePct: number;
  }> = [];
  for (const item of data.items) {
    const productId = item.productId || null;
    const requestedColor = item.colorPreference?.trim() || null;
    // Clamp discount to a sane 0–100 range; the schema already validates it.
    const discountPct = Math.min(100, Math.max(0, item.discountPct ?? 0));
    const taxRatePct = Math.min(100, Math.max(0, item.taxRatePct ?? 15));
    if (!productId) {
      if (requestedColor) {
        return { ok: false, error: "A colour preference requires a catalogue product." };
      }
      normalizedItems.push({ ...item, productId: null, colorPreference: null, discountPct, taxRatePct });
      continue;
    }

    const product = productsById.get(productId);
    if (!product) return { ok: false, error: "A product on this quote is no longer available." };
    const canonicalColor = requestedColor
      ? product.colors.find((color) => color.name.toLocaleLowerCase() === requestedColor.toLocaleLowerCase())?.name
      : null;
    if (requestedColor && !canonicalColor) {
      return { ok: false, error: `“${requestedColor}” is not configured for this product.` };
    }
    normalizedItems.push({ ...item, productId, colorPreference: canonicalColor ?? null, discountPct, taxRatePct });
  }

  const normalizedFees = (data.fees ?? []).map((fee) => ({
    label: fee.label.trim(),
    kind: fee.kind === "delivery" ? "delivery" : "fee",
    amountCents: Math.round(fee.amountCents),
    taxRatePct: Math.min(100, Math.max(0, fee.taxRatePct ?? 15)),
  }));
  const cpqQuoteData = {
    taxInclusive: data.taxInclusive ?? true,
    depositType: data.depositType ?? null,
    depositValue: data.depositValue ?? null,
  };

  const contact = await prisma.contact.findUnique({
    where: { id: data.contactId },
    select: { id: true, firstName: true, lastName: true, company: true, isCompany: true },
  });
  if (!contact) return { ok: false, error: "That customer is no longer available." };

  let validUntil: Date | null = null;
  if (data.validUntil) {
    validUntil = new Date(`${data.validUntil}T12:00:00`);
    if (Number.isNaN(validUntil.getTime())) {
      return { ok: false, error: "Enter a valid expiry date." };
    }
  }

  const createDefaults = data.id
    ? null
    : await Promise.all([getSetting("QUOTE_VALID_DAYS"), getSetting("QUOTE_TERMS")]);

  const result = await basePrisma.$transaction(async (tx) => {
    if (data.id) {
      const existing = await tx.quote.findUnique({ where: { id: data.id } });
      if (
        !existing ||
        existing.deletedAt ||
        existing.status !== "draft" ||
        existing.signToken ||
        existing.signedAt ||
        existing.supersededAt
      ) {
        return null;
      }
      if (existing.leadId && existing.contactId !== data.contactId) {
        throw new Error("The customer on a lead-linked quote cannot be changed.");
      }

      await tx.quote.update({
        where: { id: existing.id },
        data: {
          contactId: data.contactId,
          validUntil,
          terms: data.terms || null,
          status: data.intent,
          ...cpqQuoteData,
        },
      });
      await tx.quoteItem.deleteMany({ where: { quoteId: existing.id } });
      if (normalizedItems.length > 0) {
        await tx.quoteItem.createMany({
          data: normalizedItems.map((item) => ({ ...item, quoteId: existing.id })),
        });
      }
      await tx.quoteFee.deleteMany({ where: { quoteId: existing.id } });
      if (normalizedFees.length > 0) {
        await tx.quoteFee.createMany({
          data: normalizedFees.map((fee, index) => ({ ...fee, sortOrder: index, quoteId: existing.id })),
        });
      }
      return tx.quote.findUniqueOrThrow({ where: { id: existing.id } });
    }

    const max = await tx.quote.aggregate({ _max: { number: true } });
    const validDaysRaw = createDefaults?.[0];
    const validDays = validDaysRaw ? parseInt(validDaysRaw, 10) : 7;
    const defaultTerms =
      createDefaults?.[1] ||
      "Prices include VAT. Delivery arranged on acceptance. E&OE.";

    return tx.quote.create({
      data: {
        number: (max._max.number ?? 1000) + 1,
        contactId: data.contactId,
        createdById: user.id,
        validUntil: validUntil ?? addDays(new Date(), Number.isNaN(validDays) ? 7 : validDays),
        terms: data.terms || defaultTerms,
        status: data.intent,
        ...cpqQuoteData,
        items: normalizedItems.length > 0 ? { create: normalizedItems } : undefined,
        fees: normalizedFees.length > 0 ? { create: normalizedFees.map((fee, index) => ({ ...fee, sortOrder: index })) } : undefined,
      },
    });
  });

  if (!result) {
    return {
      ok: false,
      error: "This quote is locked or no longer editable. Refresh to see its latest state.",
    };
  }

  const total = normalizedItems.reduce(
    (sum, item) => sum + item.qty * item.unitPriceCents * (1 - item.discountPct / 100),
    0,
  );
  await logAudit({
    action: data.intent === "sent" ? "quote.sent" : data.id ? "quote.updated" : "quote.created",
    summary:
      data.intent === "sent"
        ? `Quote Q-${result.number} (${formatZAR(Math.round(total))}) marked sent to the customer`
        : `${data.id ? "Updated" : "Created"} quote Q-${result.number} for ${contactName(contact)}`,
    leadId: result.leadId,
    contactId: data.contactId,
    user,
  });

  revalidatePath("/quotes");
  revalidatePath(`/quotes/${result.id}`);
  return {
    ok: true,
    quote: {
      id: result.id,
      number: result.number,
      status: result.status,
      updatedAt: result.updatedAt.toISOString(),
    },
  };
}

/**
 * A quote is frozen once a signing link exists, it has been signed, it was
 * superseded by a revision, or it has left draft (customers must never see a
 * quote change under them — revise instead).
 */
async function quoteLocked(quoteId: string): Promise<boolean> {
  const quote = await prisma.quote.findUnique({ where: { id: quoteId } });
  return (
    !quote ||
    Boolean(quote.signToken) ||
    Boolean(quote.signedAt) ||
    Boolean(quote.supersededAt) ||
    quote.status !== "draft"
  );
}

export async function createQuoteRevision(quoteId: string) {
  const user = await requireQuoteAccess(quoteId, "quotes.edit");
  const original = await prisma.quote.findUniqueOrThrow({
    where: { id: quoteId },
    include: { items: true },
  });
  if (original.supersededAt || original.signedAt) return;
  const max = await basePrisma.quote.aggregate({ _max: { number: true } });
  const validDaysRaw = await getSetting("QUOTE_VALID_DAYS");
  const validDays = validDaysRaw ? parseInt(validDaysRaw, 10) : 7;
  const revision = await prisma.quote.create({
    data: {
      number: (max._max.number ?? 1000) + 1,
      contactId: original.contactId,
      leadId: original.leadId,
      createdById: user.id,
      validUntil: addDays(new Date(), isNaN(validDays) ? 7 : validDays),
      terms: original.terms,
      revisionOfId: original.id,
      items: {
        create: original.items.map((i) => ({
          description: i.description,
          qty: i.qty,
          unitPriceCents: i.unitPriceCents,
          productId: i.productId,
          colorPreference: i.colorPreference,
        })),
      },
    },
  });
  await prisma.quote.update({
    where: { id: original.id },
    data: { supersededAt: new Date(), signToken: null, signLinkCreatedAt: null, reminderSentAt: null },
  });
  await logAudit({
    action: "quote.revised",
    summary: `Quote Q-${original.number} superseded by revision Q-${revision.number}`,
    leadId: original.leadId,
    contactId: original.contactId,
    user,
  });
  revalidatePath("/quotes");
  revalidatePath(`/quotes/${quoteId}`);
  redirect(`/quotes/${revision.id}`);
}

export async function addQuoteItem(quoteId: string, formData: FormData) {
  await requireQuoteAccess(quoteId, "quotes.edit");
  if (await quoteLocked(quoteId)) return;
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
  await requireQuoteAccess(quoteId, "quotes.edit");
  void formData;
  if (await quoteLocked(quoteId)) return;
  await prisma.quoteItem.delete({ where: { id } });
  revalidatePath(`/quotes/${quoteId}`);
}

export async function updateQuoteMeta(quoteId: string, formData: FormData) {
  await requireQuoteAccess(quoteId, "quotes.edit");
  if (await quoteLocked(quoteId)) return;
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

async function reopenLeadIfNoAcceptedQuote(
  leadId: string,
  quoteNumber: number,
  user: PermissionUser
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
  const user = await requireQuoteAccess(quoteId, "quotes.change_status");
  const before = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId } });
  if (before.signedAt || before.supersededAt) return;
  const allowed = new Set(["draft", "sent", "accepted", "declined"]);
  if (!allowed.has(status)) throw new Error("Invalid quote status");
  const quote = await prisma.quote.update({
    where: { id: quoteId },
    data: { status },
    include: { items: true, lead: true },
  });
  const total = quoteTotalCents(quote.items);
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
  if (status === "accepted" && quote.leadId && quote.lead?.status === "open") {
    await prisma.lead.update({ where: { id: quote.leadId }, data: { status: "won" } });
    await markReferralEarned(quote.leadId).catch(() => {});
    await runLeadAutomations("lead_won", quote.leadId);
    await logAudit({
      action: "lead.won",
      summary: `Lead “${quote.lead.title}” won via accepted quote Q-${quote.number} 🎉`,
      leadId: quote.leadId,
      contactId: quote.contactId,
      user,
    });
  }
  if (before.status === "accepted" && status !== "accepted" && quote.leadId) {
    await reopenLeadIfNoAcceptedQuote(quote.leadId, quote.number, user);
  }
  revalidatePath("/quotes");
  revalidatePath(`/quotes/${quoteId}`);
  if (quote.leadId) revalidatePath(`/leads/${quote.leadId}`);
}

export async function deleteQuote(id: string, formData: FormData) {
  const user = await requireQuoteAccess(id, "quotes.delete");
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  const quote = await softDeleteRecord("quote", id, reason, user.name);
  await logAudit({
    action: "trash.deleted",
    summary: `Moved quote Q-${quote.number} to trash — ${reason}`,
    leadId: quote.leadId,
    contactId: quote.contactId,
    user,
  });
  if (quote.status === "accepted" && quote.leadId) {
    await reopenLeadIfNoAcceptedQuote(quote.leadId, quote.number, user);
  }
  revalidatePath("/quotes");
  redirect("/quotes");
}
