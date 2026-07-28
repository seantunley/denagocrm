"use server";

import { asActionResult, ActionRefusal } from "@/lib/actionResult";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addDays } from "date-fns";
import type { Prisma } from "@prisma/client";
import { prisma, basePrisma } from "@/lib/db";
import { quoteTotalCents } from "@/lib/pricing";
import { logAudit } from "@/lib/audit";
import { CLOSED_REQUEST_STATUSES } from "@/lib/signing/status";
import { getSetting } from "@/lib/settings";
import { markReferralEarned } from "@/lib/referrals";
import { withEditableQuote, hasOpenSignatureRequest } from "@/lib/quoteLock";
import { nextQuoteNumber } from "@/lib/numbering";
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
  leadId: z.string().trim().min(1).nullable().optional(),
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
  const validDaysRaw = await getSetting("QUOTE_VALID_DAYS");
  const validDays = validDaysRaw ? parseInt(validDaysRaw, 10) : 7;
  const terms =
    (await getSetting("QUOTE_TERMS")) ||
    "Prices include VAT. Delivery arranged on acceptance. E&OE.";
  // Allocate the number and insert in ONE transaction under the advisory lock so
  // two concurrent creates can't read the same MAX(number) and collide (#11).
  const quote = await basePrisma.$transaction(async (tx) => {
    const number = await nextQuoteNumber(tx);
    return tx.quote.create({
      data: {
        number,
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
  return asActionResult(async () => {
    const quote = await createQuoteFromLeadRecord(leadId);
    redirect(`/quotes/${quote.id}`);
  });
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
  const validDaysRaw = await getSetting("QUOTE_VALID_DAYS");
  const validDays = validDaysRaw ? parseInt(validDaysRaw, 10) : 7;
  const terms =
    (await getSetting("QUOTE_TERMS")) ||
    "Prices include VAT. Delivery arranged on acceptance. E&OE.";
  // Advisory-locked allocation + insert in one transaction (#11).
  const quote = await basePrisma.$transaction(async (tx) => {
    const number = await nextQuoteNumber(tx);
    return tx.quote.create({
      data: {
        number,
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

  // Optional lead link (new quotes only). Verify the lead exists and belongs to
  // the chosen customer so a quote can't be tied to someone else's lead.
  let linkedLeadId: string | null = null;
  if (!data.id && data.leadId) {
    const lead = await prisma.lead.findUnique({
      where: { id: data.leadId },
      select: { id: true, contactId: true },
    });
    if (!lead) return { ok: false, error: "That lead is no longer available." };
    if (lead.contactId && lead.contactId !== data.contactId) {
      return { ok: false, error: "That lead belongs to a different customer." };
    }
    linkedLeadId = lead.id;
  }

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
      // Lock the quote row FOR UPDATE and re-check editability inside the
      // transaction (including an open signing request) so a concurrent send /
      // signing-start / revision can't turn it non-editable between the read and
      // the header+items+fees rewrite below.
      await tx.$executeRaw`SELECT id FROM "Quote" WHERE id = ${data.id} FOR UPDATE`;
      const existing = await tx.quote.findUnique({ where: { id: data.id } });
      if (
        !existing ||
        existing.deletedAt ||
        existing.status !== "draft" ||
        existing.signToken ||
        existing.signedAt ||
        existing.supersededAt ||
        (await hasOpenSignatureRequest(tx, existing.id))
      ) {
        return null;
      }
      if (existing.leadId && existing.contactId !== data.contactId) {
        throw new Error("The customer on a lead-linked quote cannot be changed.");
      }
      // #15: requireQuoteAccess only authorized the quote. Moving an existing
      // quote onto a DIFFERENT contact requires access to that destination too,
      // or a user could re-file their quote against a customer they can't access.
      if (existing.contactId !== data.contactId) {
        await requireContactAccess(data.contactId, "quotes.edit");
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

    const number = await nextQuoteNumber(tx); // advisory-locked allocation (#11)
    const validDaysRaw = createDefaults?.[0];
    const validDays = validDaysRaw ? parseInt(validDaysRaw, 10) : 7;
    const defaultTerms =
      createDefaults?.[1] ||
      "Prices include VAT. Delivery arranged on acceptance. E&OE.";

    return tx.quote.create({
      data: {
        number,
        contactId: data.contactId,
        leadId: linkedLeadId,
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

export async function createQuoteRevision(quoteId: string) {
  return asActionResult(async () => {
    const user = await requireQuoteAccess(quoteId, "quotes.edit");
    const validDaysRaw = await getSetting("QUOTE_VALID_DAYS");
    const validDays = validDaysRaw ? parseInt(validDaysRaw, 10) : 7;
    const validUntil = addDays(new Date(), isNaN(validDays) ? 7 : validDays);

    // One transaction: lock the original FOR UPDATE so two concurrent revision
    // requests can't both spawn a revision (the loser re-reads supersededAt set and
    // bails), allocate the number under the advisory lock (#11), copy ALL commercial
    // data — items with discount/tax/cost/optional/selected/sort, fees, tax mode and
    // deposit (the old copy dropped everything but description/qty/price/product/
    // colour, #10) — then supersede the original. All commit together.
    const revision = await basePrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Quote" WHERE id = ${quoteId} FOR UPDATE`;
      const original = await tx.quote.findUnique({
        where: { id: quoteId },
        include: { items: true, fees: true },
      });
      if (!original || original.deletedAt || original.supersededAt || original.signedAt) return null;
      // A live signing request must be voided before revising — otherwise the
      // superseded quote would keep a live customer signing link.
      if (await hasOpenSignatureRequest(tx, quoteId)) return { blocked: true as const };

      const number = await nextQuoteNumber(tx);
      const created = await tx.quote.create({
        data: {
          number,
          contactId: original.contactId,
          leadId: original.leadId,
          createdById: user.id,
          validUntil,
          terms: original.terms,
          taxInclusive: original.taxInclusive,
          depositType: original.depositType,
          depositValue: original.depositValue,
          revisionOfId: original.id,
          items: {
            create: original.items.map((i) => ({
              description: i.description,
              qty: i.qty,
              unitPriceCents: i.unitPriceCents,
              discountPct: i.discountPct,
              colorPreference: i.colorPreference,
              kind: i.kind,
              taxRatePct: i.taxRatePct,
              costCents: i.costCents,
              optional: i.optional,
              selected: i.selected,
              sortOrder: i.sortOrder,
              productId: i.productId,
            })),
          },
          fees: {
            create: original.fees.map((f) => ({
              label: f.label,
              kind: f.kind,
              amountCents: f.amountCents,
              taxRatePct: f.taxRatePct,
              sortOrder: f.sortOrder,
            })),
          },
        },
      });
      // Carry over the original's quote custom-field values so the revision isn't
      // missing data captured on the original (@@unique[defId,recordId] keeps the
      // new recordId collision-free).
      const cfValues = await tx.customFieldValue.findMany({
        where: { recordId: original.id, def: { entity: "quote" } },
        select: { defId: true, value: true },
      });
      if (cfValues.length > 0) {
        await tx.customFieldValue.createMany({
          data: cfValues.map((v) => ({ defId: v.defId, recordId: created.id, value: v.value })),
        });
      }
      await tx.quote.update({
        where: { id: original.id },
        data: { supersededAt: new Date(), signToken: null, signLinkCreatedAt: null, reminderSentAt: null },
      });
      return { id: created.id, number: created.number, originalNumber: original.number, leadId: original.leadId, contactId: original.contactId };
    });

    if (!revision) return;
    if ("blocked" in revision) {
      throw new ActionRefusal("Void the open signing request before creating a revision.");
    }
    await logAudit({
      action: "quote.revised",
      summary: `Quote Q-${revision.originalNumber} superseded by revision Q-${revision.number}`,
      leadId: revision.leadId,
      contactId: revision.contactId,
      user,
    });
    revalidatePath("/quotes");
    revalidatePath(`/quotes/${quoteId}`);
    redirect(`/quotes/${revision.id}`);
  });
}

export async function addQuoteItem(quoteId: string, formData: FormData) {
  return asActionResult(async () => {
    await requireQuoteAccess(quoteId, "quotes.edit");
    const description = String(formData.get("description") ?? "").trim();
    if (!description) return;
    const qty = parseFloat(String(formData.get("qty") ?? "1")) || 1;
    const unitPriceCents = parseRands(String(formData.get("unitPrice") ?? ""));
    // Lock the quote FOR UPDATE and re-check editability inside the transaction —
    // a preflight-only check let a concurrent send/sign edit a locked quote.
    await withEditableQuote(quoteId, async (tx) => {
      await tx.quoteItem.create({ data: { quoteId, description, qty, unitPriceCents } });
    });
    revalidatePath(`/quotes/${quoteId}`);
  });
}

export async function deleteQuoteItem(id: string, quoteId: string, formData: FormData) {
  return asActionResult(async () => {
    await requireQuoteAccess(quoteId, "quotes.edit");
    void formData;
    // Scope to the authorized quote — deleting by item id alone let a user with
    // edit access to their quote delete a line off another quote — under the lock.
    await withEditableQuote(quoteId, async (tx) => {
      await tx.quoteItem.deleteMany({ where: { id, quoteId } });
    });
    revalidatePath(`/quotes/${quoteId}`);
  });
}

export async function updateQuoteMeta(quoteId: string, formData: FormData) {
  return asActionResult(async () => {
    await requireQuoteAccess(quoteId, "quotes.edit");
    const validUntilRaw = String(formData.get("validUntil") ?? "").trim();
    const terms = String(formData.get("terms") ?? "").trim() || null;
    await withEditableQuote(quoteId, async (tx) => {
      await tx.quote.update({
        where: { id: quoteId },
        data: { validUntil: validUntilRaw ? new Date(validUntilRaw) : null, terms },
      });
    });
    revalidatePath(`/quotes/${quoteId}`);
  });
}

/**
 * Reopen a won lead when the quote that won it stops being accepted — run INSIDE
 * the caller's quote transaction so the quote transition (declined / trashed) and
 * the lead reopen commit atomically; a crash can't leave an accepted-quote-gone
 * lead stuck "won". Locks the lead row, counts live accepted quotes under the
 * lock (also serializing with setQuoteStatus's in-tx lead-won), and reopens only
 * when none remain. Returns the reopened lead (for a post-commit audit) or null.
 */
async function reopenLeadInTx(
  tx: Prisma.TransactionClient,
  leadId: string,
): Promise<{ title: string; contactId: string | null } | null> {
  await tx.$executeRaw`SELECT id FROM "Lead" WHERE id = ${leadId} FOR UPDATE`;
  const lead = await tx.lead.findFirst({ where: { id: leadId, deletedAt: null } });
  if (!lead || lead.status !== "won") return null;
  const stillAccepted = await tx.quote.count({ where: { leadId, status: "accepted", deletedAt: null } });
  if (stillAccepted > 0) return null;
  await tx.lead.update({ where: { id: leadId }, data: { status: "open" } });
  return { title: lead.title, contactId: lead.contactId };
}

/** Post-commit audit + revalidate for a lead reopened by {@link reopenLeadInTx}. */
async function auditLeadReopened(
  reopened: { title: string; contactId: string | null },
  leadId: string,
  quoteNumber: number,
  user: PermissionUser,
) {
  await logAudit({
    action: "lead.reopened",
    summary: `Lead “${reopened.title}” reopened — quote Q-${quoteNumber} is no longer accepted, so it doesn't count as a sale`,
    leadId,
    contactId: reopened.contactId,
    user,
  });
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
  revalidatePath("/reports");
}

export async function setQuoteStatus(quoteId: string, status: string) {
  return asActionResult(async () => {
    const user = await requireQuoteAccess(quoteId, "quotes.change_status");
    const allowed = new Set(["draft", "sent", "accepted", "declined"]);
    if (!allowed.has(status)) throw new ActionRefusal("Invalid quote status");
    // Lock the quote FOR UPDATE and re-check signed/superseded inside the
    // transaction so a concurrent createQuoteRevision can't supersede it between
    // the check and the write — which would run lead-won/referral side-effects
    // against an obsolete quote.
    const result = await basePrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Quote" WHERE id = ${quoteId} FOR UPDATE`;
      const before = await tx.quote.findUnique({ where: { id: quoteId } });
      if (!before || before.deletedAt || before.signedAt || before.supersededAt) return null;
      // Don't let staff manually accept/decline a quote that's out for signature —
      // void the request first. (draft/sent moves are still allowed.)
      if ((status === "accepted" || status === "declined") && (await hasOpenSignatureRequest(tx, quoteId))) {
        return { blocked: true as const };
      }
      const updated = await tx.quote.update({
        where: { id: quoteId },
        data: { status },
        include: { items: true, lead: true },
      });
      // Win the lead in the SAME transaction, locked, so a concurrent accept/decline
      // can't leave quote and lead status diverged (e.g. quote declined, lead won).
      let wonLeadId: string | null = null;
      if (status === "accepted" && updated.leadId) {
        await tx.$executeRaw`SELECT id FROM "Lead" WHERE id = ${updated.leadId} FOR UPDATE`;
        const won = await tx.lead.updateMany({ where: { id: updated.leadId, deletedAt: null, status: "open" }, data: { status: "won" } });
        if (won.count === 1) wonLeadId = updated.leadId;
      }
      // Reopen the lead in the SAME transaction when this quote stops being accepted,
      // so the status change and the reopen are atomic.
      let reopenedLead: { title: string; contactId: string | null } | null = null;
      if (before.status === "accepted" && status !== "accepted" && updated.leadId) {
        reopenedLead = await reopenLeadInTx(tx, updated.leadId);
      }
      return { beforeStatus: before.status, quote: updated, wonLeadId, reopenedLead };
    });
    if (!result) return;
    if ("blocked" in result) {
      throw new ActionRefusal("This quote is out for signature — void the signing request before changing its status.");
    }
    const { quote, wonLeadId, reopenedLead } = result;
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
    // External, best-effort lead-won fan-out — gated on the in-transaction win so it
    // fires exactly once and never for a quote that didn't actually win the lead.
    if (wonLeadId) {
      await markReferralEarned(wonLeadId).catch(() => {});
      await runLeadAutomations("lead_won", wonLeadId);
      await logAudit({
        action: "lead.won",
        summary: `Lead “${quote.lead?.title ?? ""}” won via accepted quote Q-${quote.number} 🎉`,
        leadId: wonLeadId,
        contactId: quote.contactId,
        user,
      });
    }
    if (reopenedLead && quote.leadId) {
      await auditLeadReopened(reopenedLead, quote.leadId, quote.number, user);
    }
    revalidatePath("/quotes");
    revalidatePath(`/quotes/${quoteId}`);
    if (quote.leadId) revalidatePath(`/leads/${quote.leadId}`);
  });
}

export async function deleteQuote(id: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireQuoteAccess(id, "quotes.delete");
    const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
    // Void any live signing request AND soft-delete the quote in one locked
    // transaction, so a trashed quote can't still be signed via a live customer
    // link, and a concurrent signing start (which locks the same row) can't race.
    const { quote, reopenedLead } = await basePrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Quote" WHERE id = ${id} FOR UPDATE`;
      await tx.signatureRequest.updateMany({
        where: { quoteId: id, deletedAt: null, status: { notIn: [...CLOSED_REQUEST_STATUSES] } },
        data: { status: "voided" },
      });
      const updated = await tx.quote.update({
        where: { id },
        data: { deletedAt: new Date(), deleteReason: reason, deletedByName: user.name },
      });
      // Reopen the lead in the SAME transaction so trashing an accepted quote and
      // reopening its lead are atomic (no accepted-quote-gone lead stuck "won").
      const reopened =
        updated.status === "accepted" && updated.leadId ? await reopenLeadInTx(tx, updated.leadId) : null;
      return { quote: updated, reopenedLead: reopened };
    });
    await logAudit({
      action: "trash.deleted",
      summary: `Moved quote Q-${quote.number} to trash — ${reason}`,
      leadId: quote.leadId,
      contactId: quote.contactId,
      user,
    });
    if (reopenedLead && quote.leadId) {
      await auditLeadReopened(reopenedLead, quote.leadId, quote.number, user);
    }
    revalidatePath("/quotes");
    redirect("/quotes");
  });
}
