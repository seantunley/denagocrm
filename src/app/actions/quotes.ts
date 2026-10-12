"use server";
import { withActingStaffScope } from "@/lib/actingScope";

import { asActionResult, ActionRefusal, refuse } from "@/lib/actionResult";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma, basePrisma } from "@/lib/db";
import { payableTotalCents } from "@/lib/pricing";
import { QUOTE_PDF_SOURCE } from "@/lib/assistantWhatsAppRules";
import { CONFIRM_KEY } from "@/lib/assistantActions";
import { tenantOrigin } from "@/lib/tenantOrigin";
import { logAudit, GOVERNANCE_TX } from "@/lib/audit";
import { CLOSED_REQUEST_STATUSES } from "@/lib/signing/status";
import { hasOpenSignatureRequest } from "@/lib/quoteLock";
import { acceptQuoteInTx, afterDealWon, cancelQuoteInTx, duplicateQuoteInTx } from "@/lib/quoteOutcome";
import { addStockEvent } from "@/lib/stockPlatform";
import { nextQuoteNumber } from "@/lib/numbering";
import { insertQuoteFromLead, quoteFromLeadDefaults } from "@/lib/quoteFromLead";
import { actingTenantId } from "@/lib/actingTenant";
import { feeRowsFor, itemRowsFor, priorById } from "@/lib/quoteRows";
import { calendarDateInstant } from "@/lib/quoteExpiry";
import { getRegionalSettings } from "@/lib/settings";
import { emitLeadJourneyEvent } from "@/lib/leadJourneyEvents";
import { formatZAR, contactName } from "@/lib/format";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { activeTenantPredicate } from "@/lib/tenantPredicate";
import { loadBillToFleets, quoteBillTo } from "@/lib/quoteBillTo";
import {
  requireLeadAccess,
  requireContactAccess,
  canAccessLead,
  requirePermission,
  requireQuoteAccess,
  canAccessQuote,
  hasPermission,
  hasAnyPermission,
  type PermissionUser,
} from "@/lib/permissions";
import {
  QUOTE_EDITOR_INCLUDE,
  buildQuoteEditorRecord,
  loadQuoteVersions,
  quoteVersionIndex,
} from "@/lib/quoteEditorRecord";
import type { QuoteEditorRecord } from "@/components/quotes/QuoteEditorDialog";

const quoteDraftSchema = z.object({
  id: z.string().trim().min(1).optional(),
  contactId: z.string().trim().min(1, "Select a customer."),
  leadId: z.string().trim().min(1).nullable().optional(),
  validUntil: z.string().trim().max(10).nullable().optional(),
  terms: z.string().trim().max(10_000, "Terms are too long."),
  intent: z.enum(["draft", "sent"]),
  items: z.array(
    z.object({
      // The row this line came from, when it is an edit rather than an addition.
      // saveQuoteDraft replaces every row, so without it the CPQ columns the
      // editor does not show — kind, costCents, optional, selected, per-line
      // VAT — would silently revert to schema defaults on every save.
      id: z.string().trim().min(1).nullable().optional(),
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
      id: z.string().trim().min(1).nullable().optional(),
      label: z.string().trim().min(1).max(120),
      kind: z.enum(["fee", "delivery"]).optional(),
      amountCents: z.number().int(),
      taxRatePct: z.number().finite().min(0).max(100).optional(),
    }),
  ).max(20).optional(),
  /**
   * On a draft (new, or one being added to): also queue this quote's PDF for the person saving it, to the
   * WhatsApp THEY linked (the assistant's "build me a quote"). It says who by
   * being who is signed in — there is no recipient to name — so the most anyone
   * can do with it is have their own draft sent to their own verified phone.
   */
  pdfToMyWhatsApp: z.boolean().optional(),
  /**
   * On an existing draft: `items` and `fees` are ADDITIONS. Nothing already on
   * the quote is changed — its rows, customer, expiry, terms, VAT mode and
   * deposit are left as they are, whatever else this request says.
   */
  appendOnly: z.boolean().optional(),
  /**
   * On an existing draft: CHANGE or REMOVE rows that are already on it (the
   * assistant's "rename the delivery fee", "make it 3", "take that off"). Each
   * names a row by id and says how it read when the change was proposed (`was`);
   * a row that no longer reads that way stops the whole save. Nothing else on the
   * quote is touched, and `items` / `fees` in the same request are ignored.
   * A line's price is not among the things that can be changed.
   */
  changes: z.array(z.discriminatedUnion("row", [
    z.object({
      row: z.literal("fee"), id: z.string().trim().min(1),
      was: z.object({ label: z.string(), amountCents: z.number().int() }),
      remove: z.literal(true).optional(),
      label: z.string().trim().min(1).max(120).optional(),
      amountCents: z.number().int().positive().max(100_000_000).optional(),
    }).strict(),
    z.object({
      row: z.literal("line"), id: z.string().trim().min(1),
      was: z.object({ description: z.string(), qty: z.number(), discountPct: z.number(), colour: z.string().nullable() }),
      remove: z.literal(true).optional(),
      qty: z.number().int().min(1).max(500).optional(),
      discountPct: z.number().finite().min(0).max(100).optional(),
      colour: z.string().trim().min(1).max(100).optional(),
    }).strict(),
  ])).min(1).max(20).optional(),
  /** The key of the assistant card being confirmed: a card is carried out once (see claimConfirmKey). */
  confirmKey: z.string().regex(CONFIRM_KEY).optional(),
});

/** How long a spent confirm key is kept: longer than a card stays in the Ask history (30 days). */
const CONFIRM_KEY_KEPT_MS = 35 * 24 * 60 * 60 * 1000;
const REPEATED = "repeated" as const;
/** A row a change names no longer reads the way the card showed it. */
const STALE = "stale" as const;
type PricedItem = Parameters<typeof payableTotalCents>[0]["items"][number];
type PricedFee = NonNullable<Parameters<typeof payableTotalCents>[0]["fees"]>[number];

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
  /** `repeated`: this exact assistant card was already carried out — nothing was changed this time. */
  | { ok: false; error: string; repeated?: true };

/** Creates a draft quote from a lead, pre-filled with its product line. */
async function createQuoteFromLeadRecord(leadId: string) {
  const user = await requireLeadAccess(leadId, "quotes.create");
  const lead = await prisma.lead.findUniqueOrThrow({
    where: { id: leadId },
    include: { product: true },
  });
  // Settings first, then ONE transaction holding the advisory lock for the number
  // allocation and the insert together, so two concurrent creates can't read the
  // same MAX(number) and collide (#11). Both halves now live in
  // `lib/quoteFromLead.ts` so the `attach_quote` stage remedy — which must create
  // the quote and move the lead in one transaction — shares this definition of
  // what a lead-seeded quote contains rather than keeping a second copy.
  const defaults = await quoteFromLeadDefaults();
  const tenantId = await actingTenantId();
  const quote = await basePrisma.$transaction((tx) =>
    insertQuoteFromLead(tx, { lead, tenantId, createdById: user.id, defaults }),
  );
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

/**
 * Creates the quote and opens the DRAFT EDITOR.
 *
 * Every route to a new quote now lands in the same place. Creating from a lead
 * used to drop you on the read-only record page while the quotes list and the
 * lead's own "next step" prompt opened the modal — the same intent, from the
 * same lead, in two different UIs depending on which button was pressed. The
 * record page is unchanged and still reachable from the editor's "Open full
 * record" link.
 */
export async function createQuoteFromLead(leadId: string) {
  return asActionResult(async () => {
    const quote = await createQuoteFromLeadRecord(leadId);
    return { redirectTo: `/quotes?edit=${quote.id}` };
  });
}

/** Creates a quote directly for an existing customer (no lead needed). */
export async function createQuoteForContact(formData: FormData) {
  return withActingStaffScope(async () => {
    const contactId = String(formData.get("contactId") ?? "").trim();
    const productId = String(formData.get("productId") ?? "").trim() || null;
    if (!contactId) throw new Error("Customer is required");
    const user = await requireContactAccess(contactId, "quotes.create");

    const product = productId
      ? await prisma.product.findUnique({ where: { id: productId } })
      : null;
    const { validUntil, terms, regional } = await quoteFromLeadDefaults();
    // Advisory-locked allocation + insert in one transaction (#11). The bypass
    // client carries no tenant, so the row and its children are stamped here.
    const tenantId = await actingTenantId();
    const quote = await basePrisma.$transaction(async (tx) => {
      const number = await nextQuoteNumber(tx);
      return tx.quote.create({
        data: {
          number,
          tenantId,
          contactId,
          createdById: user.id,
          validUntil,
          terms,
          items: product
            ? {
                create: [
                  {
                    tenantId,
                    description: product.name,
                    qty: 1,
                    unitPriceCents: product.basePriceCents,
                    productId: product.id,
                    taxRatePct: regional.vatRatePct,
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
      // No fleet by construction — this path creates a quote for one person — so
      // the resolver is passed null rather than asked to look one up.
      summary: `Created quote Q-${quote.number} for ${quoteBillTo(quote, null).name || "customer"}`,
      contactId,
      user,
    });
    revalidatePath("/quotes");
    // Lands in the editor like every other route to a new quote. NOTE: nothing in
    // the UI calls this today, and it differs from createQuoteFromLead in ways
    // that would surprise whoever wires it up — it prices at the product's base
    // price rather than the lead's agreed value, and links no lead. Decide those
    // before giving it a button.
    redirect(`/quotes?edit=${quote.id}`);
  });
}

/**
 * Creates a draft quote BILLED TO A FLEET ACCOUNT, from the fleet's own page.
 *
 * The fleet is bound at creation and never afterwards, exactly like `leadId`,
 * and for the same reason: the identity of the party a quote is addressed to is
 * not an editable field on a document that becomes a signed record of what was
 * agreed. Changing it is a new quote, or a revision of this one.
 *
 * Two things are checked, and neither can be skipped by posting this action
 * directly (which anyone can — it is a public endpoint):
 *
 *  1. The FLEET resolves inside the caller's tenant. `Quote.fleetId` carries no
 *     foreign key, so this is the only thing standing between a posted id and a
 *     quote that prints another operator's customer account, registration number
 *     and VAT number.
 *  2. The CONTACT is the fleet's manager or one of its members, AND the caller
 *     may access that contact. A quote naming fleet A beside an unrelated person
 *     is a tax document that misstates who is buying; and `contactId` is what
 *     every access check on the resulting quote is keyed on, so an unchecked one
 *     would be a quote the creator cannot open.
 */
/**
 * Bound with {@link withActingStaffScope} because this action reads the tenant scope
 * SYNCHRONOUSLY (inheritedTenantId / activeTenantPredicate / writeTenantId), and a
 * sync reader cannot recover a missing scope the way an awaited one can.
 *
 * A Server Action has no React request store, so #513's holder is never filled, and
 * `enterWith` inside the auth chokepoint does not reach the frame that called it —
 * the action body therefore runs with no ambient scope and the sync reader throws.
 * Binding an ENCLOSING frame here is the only shape that reaches it.
 */
export async function createQuoteForFleet(formData: FormData) {
  return withActingStaffScope(async () => {
  return asActionResult(async () => {
    // The PERMISSION gate comes before any refusal, deliberately: a refusal is a
    // reply, and replying to an unauthorised caller — even with "choose a fleet" —
    // tells them the endpoint exists and responds. The record-level check follows
    // once there is an id to check.
    await requirePermission("quotes.create");
    const fleetId = String(formData.get("fleetId") ?? "").trim();
    const contactId = String(formData.get("contactId") ?? "").trim();
    if (!fleetId) throw new ActionRefusal("Choose a fleet account.");
    if (!contactId) throw new ActionRefusal("Choose the person this quote is addressed to.");

    const user = await requireContactAccess(contactId, "quotes.create");

    const fleet = await prisma.fleet.findFirst({
      where: { id: fleetId, deletedAt: null, ...activeTenantPredicate("quote for fleet") },
      select: { id: true, name: true, contactId: true },
    });
    // One message for "not yours" and "does not exist" — anything else makes this
    // an existence oracle over other workspaces' customer accounts.
    if (!fleet) throw new ActionRefusal("That fleet account isn't available.");

    const contact = await prisma.contact.findFirst({
      where: { id: contactId, deletedAt: null, ...activeTenantPredicate("quote for fleet contact") },
      select: { id: true, fleetId: true, firstName: true, lastName: true, company: true, isCompany: true },
    });
    if (!contact) throw new ActionRefusal("That customer isn't available.");
    // Manager OR member — Fleet.contactId and Contact.fleetId are deliberately
    // different facts (see the schema), and either one makes this person the
    // right party to address the fleet's quote to.
    if (contact.fleetId !== fleet.id && fleet.contactId !== contact.id) {
      throw new ActionRefusal(
        `${contactName(contact)} isn't linked to ${fleet.name}. Add them to the fleet first.`,
      );
    }

    const { validUntil, terms } = await quoteFromLeadDefaults();

    // Advisory-locked allocation + insert in one transaction, same as every
    // other quote-creating path (#11).
    const tenantId = await actingTenantId();
    const quote = await basePrisma.$transaction(async (tx) => {
      const number = await nextQuoteNumber(tx);
      return tx.quote.create({
        data: {
          number,
          tenantId,
          contactId: contact.id,
          fleetId: fleet.id,
          createdById: user.id,
          validUntil,
          terms,
        },
        select: { id: true, number: true },
      });
    });

    await logAudit({
      action: "quote.created",
      summary: `Created quote Q-${quote.number} for fleet ${fleet.name}`,
      contactId: contact.id,
      user,
      entityType: "Quote",
      entityId: quote.id,
    });
    revalidatePath(`/fleets/${fleet.id}`);
    revalidatePath("/quotes");
    return { redirectTo: `/quotes?edit=${quote.id}` };
  });
  });
}

/**
 * Creates or atomically updates a quote draft for the modal editor. The client
 * supplies only editable fields; identity, locking state and quote numbering
 * are always resolved again on the server.
 */
/**
 * Bound with {@link withActingStaffScope} because this action reads the tenant scope
 * SYNCHRONOUSLY (inheritedTenantId / activeTenantPredicate / writeTenantId), and a
 * sync reader cannot recover a missing scope the way an awaited one can.
 *
 * A Server Action has no React request store, so #513's holder is never filled, and
 * `enterWith` inside the auth chokepoint does not reach the frame that called it —
 * the action body therefore runs with no ambient scope and the sync reader throws.
 * Binding an ENCLOSING frame here is the only shape that reaches it.
 */
export async function saveQuoteDraft(input: QuoteDraftInput): Promise<QuoteDraftResult> {
  return withActingStaffScope(async () => {
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
    id?: string | null;
    description: string;
    qty: number;
    unitPriceCents: number;
    productId: string | null;
    colorPreference: string | null;
    discountPct: number;
    taxRatePct: number | null;
  }> = [];
  for (const item of data.items) {
    const productId = item.productId || null;
    const requestedColor = item.colorPreference?.trim() || null;
    // Clamp discount to a sane 0–100 range; the schema already validates it.
    const discountPct = Math.min(100, Math.max(0, item.discountPct ?? 0));
    // null means "the caller didn't say" — the row's existing rate is carried
    // forward below, and only a genuinely new line falls back to the default.
    const taxRatePct = item.taxRatePct == null ? null : Math.min(100, Math.max(0, item.taxRatePct));
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
    id: fee.id ?? null,
    label: fee.label.trim(),
    kind: fee.kind === "delivery" ? "delivery" : "fee",
    amountCents: Math.round(fee.amountCents),
    taxRatePct: fee.taxRatePct == null ? null : Math.min(100, Math.max(0, fee.taxRatePct)),
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
    /*
     * AND the caller must be able to SEE this lead.
     *
     * The checks above ask whether the lead exists and whether it belongs to
     * the chosen customer. Neither asks whether this user may open it, and a
     * server action is reachable by direct POST - so a leadId that never
     * appeared in anyone's picker could still be attached here. Scoping the
     * picker query alone would have left that open.
     *
     * Deliberately the same refusal as a missing lead: telling somebody a
     * lead exists but is not theirs confirms the record.
     */
    if (!(await canAccessLead(user, lead.id))) {
      return { ok: false, error: "That lead is no longer available." };
    }
    linkedLeadId = lead.id;
  }

  // Needed on edits too: a line ADDED to an existing draft takes the workspace's
  // current VAT rate, while the lines already on it keep their own.
  const createDefaults = await quoteFromLeadDefaults();

  // The editor sends a workspace-calendar date; it is stored as that date, not
  // re-read through the server's clock — see quoteExpiry.ts.
  let validUntil: Date | null = null;
  if (data.validUntil) {
    validUntil = calendarDateInstant(data.validUntil, createDefaults.regional.timeZone);
    if (!validUntil) {
      return { ok: false, error: "Enter a valid expiry date." };
    }
  }

  // Resolved before the bypass transaction. This is the ACTOR, which is the
  // right owner for a quote being created here and only the FALLBACK for one
  // that already exists — see quoteTenantId in the edit path below.
  const actingTenant = await actingTenantId();
  // Resolved outside the transaction (a settings read), for the link in the update below.
  const quoteOrigin = data.pdfToMyWhatsApp ? (await tenantOrigin(actingTenant).catch(() => "")).replace(/\/$/, "") : "";
  /*
   * ONE CONFIRM, ONE CHANGE. A card the assistant proposed carries a key minted
   * on the server when the card was made. It is recorded HERE, in the
   * transaction that makes the change — as a row whose primary key IS the key —
   * so the change and the record of it exist together or not at all, and a
   * second Confirm of the same card (the browser lost the first answer and the
   * person pressed again) finds it and changes nothing. It is a spent
   * AssistantPendingAction: completed, never offered, pruned with the rest.
   */
  const claimConfirmKey = async (tx: Prisma.TransactionClient, what: string): Promise<boolean> => {
    if (!data.confirmKey) return true;
    // This workspace's row only (a bypass transaction: the predicate is the boundary). A key that somehow
    // existed elsewhere would still stop the insert below on its primary key, which is reported the same way.
    if (await tx.assistantPendingAction.findFirst({ where: { id: data.confirmKey, tenantId: actingTenant }, select: { id: true } })) return false;
    const now = new Date();
    await tx.assistantPendingAction.create({
      data: {
        id: data.confirmKey, tenantId: actingTenant, userId: user.id, card: { kind: "confirm_key", what },
        confirmedAt: now, completedAt: now, expiresAt: new Date(now.getTime() + CONFIRM_KEY_KEPT_MS),
      },
    });
    return true;
  };
  const result = await basePrisma.$transaction(async (tx) => {
    if (data.id) {
      // Lock the quote row FOR UPDATE and re-check editability inside the
      // transaction (including an open signing request) so a concurrent send /
      // signing-start / revision can't turn it non-editable between the read and
      // the header+items+fees rewrite below.
      //
      // The tenant predicate is on the LOCK, the READ and the UPDATE below, not
      // just on one of them. `requireQuoteAccess` above authorised the id, but
      // it leans on `activeTenantPredicate()`, which is `{}` while enforcement is
      // dormant — so it says nothing about ownership today. This runs on
      // `basePrisma`, the documented bypass, so nothing else was going to.
      //
      // Measured, not assumed: driven from workspace A against a live quote of
      // B's, this path rewrote B's terms and wrote a QuoteItem into B's quote
      // stamped with B's tenant, so the row read as an ordinary one of theirs.
      await tx.$executeRaw`SELECT id FROM "Quote" WHERE id = ${data.id} AND "tenantId" = ${actingTenant} FOR UPDATE`;
      // The existing rows ride along with the editability check rather than
      // costing two more round trips. Every row is replaced below, so anything
      // the editor does not send is lost unless it is carried across — kind,
      // cost basis, optional/selected, per-line VAT have no UI on any surface,
      // and a save was silently resetting the cost the margin is computed from
      // and re-including optional add-ons the customer had declined.
      //
      // Fetched HERE, in a query that was already being made: as two separate
      // queries inside the transaction they pushed it past Prisma's 5s
      // interactive-transaction budget on a high-latency database, and the save
      // failed with P2028 instead of committing.
      const existing = await tx.quote.findFirst({
        where: { id: data.id, tenantId: actingTenant },
        include: { items: true, fees: true },
      });
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
      // The end of every edit: the quote as saved, and — for the assistant — the
      // updated PDF queued for the person who changed it. In this transaction for
      // the same reason as on a new quote below, and to the same place: their own
      // linked phone, never a customer. It is THEIR update, not a child of the
      // quote, so it is filed in the workspace they are acting in — where their
      // phone link is looked up.
      const finish = async (itemRows: PricedItem[], feeRows: PricedFee[], cpq: typeof cpqQuoteData) => {
        const rewritten = await tx.quote.findUniqueOrThrow({ where: { id: existing.id } });
        if (data.pdfToMyWhatsApp && data.intent === "draft") {
          const total = payableTotalCents({ items: itemRows, fees: feeRows, ...cpq });
          await tx.assistantTurn.create({
            data: {
              tenantId: actingTenant,
              userId: user.id,
              source: QUOTE_PDF_SOURCE,
              quoteId: existing.id,
              question: `Draft quote Q-${existing.number} updated`,
              answer: `I've updated draft quote Q-${existing.number} (now ${formatZAR(Math.round(total))}). It has NOT been sent to the customer — sending it is your step.\n${quoteOrigin}/quotes?edit=${existing.id}`,
            },
          });
        }
        // The rows as PERSISTED, so the audit figure below is the one the database
        // and every screen agree on. Built from normalizedItems it silently
        // counted a declined add-on that nothing else charges for.
        return { quote: rewritten, itemRows, feeRows, cpq };
      };
      /*
       * ADD ONLY (the assistant's "add a delivery fee to the quote").
       *
       * The rows in the request are ADDITIONS. Nothing already on the quote is
       * read from the request, deleted or rewritten — so there is nothing of
       * anybody else's for this save to overwrite. (Its first version sent the
       * whole quote back, read BEFORE this lock: an edit a colleague saved in
       * between would have been replaced by the copy read earlier. Review of
       * #879.) The header is left exactly as it is; only its updatedAt moves.
       */
      if (data.appendOnly) {
        if (data.intent !== "draft" || existing.contactId !== data.contactId) return null;
        if (!(await claimConfirmKey(tx, `Q-${existing.number}`))) return REPEATED;
        const touched = await tx.quote.updateMany({ where: { id: existing.id, tenantId: actingTenant, status: "draft" }, data: { status: "draft" } });
        if (touched.count !== 1) return null;
        // The quote is the parent: what is added takes ITS owner (see below).
        const ownerTenantId = existing.tenantId ?? actingTenant;
        const addedItems = itemRowsFor(normalizedItems, new Map(), createDefaults.regional.vatRatePct);
        const addedFees = feeRowsFor(normalizedFees, new Map(), createDefaults.regional.vatRatePct).map((row, at) => ({ ...row, sortOrder: existing.fees.length + at }));
        if (addedItems.length > 0) await tx.quoteItem.createMany({ data: addedItems.map((row) => ({ ...row, quoteId: existing.id, tenantId: ownerTenantId })) });
        if (addedFees.length > 0) await tx.quoteFee.createMany({ data: addedFees.map((row) => ({ ...row, quoteId: existing.id, tenantId: ownerTenantId })) });
        return finish([...existing.items, ...addedItems], [...existing.fees, ...addedFees], {
          taxInclusive: existing.taxInclusive,
          depositType: existing.depositType === "percent" || existing.depositType === "amount" ? existing.depositType : null,
          depositValue: existing.depositValue,
        });
      }
      /*
       * CHANGE ROWS (the assistant's "rename the delivery fee", "take it off").
       *
       * WHAT WAS SHOWN IS WHAT IS CHANGED. The card showed each row as it read
       * then; under this lock every one of them must still read that way, or
       * nothing is changed at all — a colleague's edit in between is neither
       * overwritten nor built upon. Then only the named rows are written: each
       * by its id, on THIS quote. A product line's price cannot be changed here.
       */
      if (data.changes) {
        if (data.intent !== "draft" || existing.contactId !== data.contactId) return null;
        const ownerTenantId = existing.tenantId ?? actingTenant;
        for (const change of data.changes) {
          if (change.row === "fee") {
            const fee = existing.fees.find((row) => row.id === change.id);
            if (!fee || fee.label !== change.was.label || fee.amountCents !== change.was.amountCents) return STALE;
            continue;
          }
          const line = existing.items.find((row) => row.id === change.id);
          if (
            !line || line.description !== change.was.description || line.qty !== change.was.qty ||
            line.discountPct !== change.was.discountPct || (line.colorPreference ?? null) !== change.was.colour
          ) return STALE;
          if (change.colour && !change.remove) {
            // Only a colour this line's PRODUCT comes in, spelled as the catalogue spells it.
            const product = line.productId
              ? await tx.product.findFirst({ where: { id: line.productId, tenantId: ownerTenantId }, select: { colors: { select: { name: true } } } })
              : null;
            if (!product?.colors.some((colour) => colour.name === change.colour)) return STALE;
          }
        }
        if (!(await claimConfirmKey(tx, `Q-${existing.number}`))) return REPEATED;
        const touched = await tx.quote.updateMany({ where: { id: existing.id, tenantId: actingTenant, status: "draft" }, data: { status: "draft" } });
        if (touched.count !== 1) return null;
        let items = existing.items;
        let fees = existing.fees;
        for (const change of data.changes) {
          // Each write names the row, THIS quote and its workspace in the call itself, and must hit exactly one row.
          if (change.row === "fee") {
            const set = { ...(change.label !== undefined ? { label: change.label } : {}), ...(change.amountCents !== undefined ? { amountCents: change.amountCents } : {}) };
            const done = change.remove
              ? await tx.quoteFee.deleteMany({ where: { id: change.id, quoteId: existing.id, tenantId: ownerTenantId } })
              : await tx.quoteFee.updateMany({ where: { id: change.id, quoteId: existing.id, tenantId: ownerTenantId }, data: set });
            if (done.count !== 1) throw new Error("quote change: a fee was not there to change");
            fees = change.remove ? fees.filter((row) => row.id !== change.id) : fees.map((row) => (row.id === change.id ? { ...row, ...set } : row));
          } else {
            const set = {
              ...(change.qty !== undefined ? { qty: change.qty } : {}),
              ...(change.discountPct !== undefined ? { discountPct: change.discountPct } : {}),
              ...(change.colour !== undefined ? { colorPreference: change.colour } : {}),
            };
            const done = change.remove
              ? await tx.quoteItem.deleteMany({ where: { id: change.id, quoteId: existing.id, tenantId: ownerTenantId } })
              : await tx.quoteItem.updateMany({ where: { id: change.id, quoteId: existing.id, tenantId: ownerTenantId }, data: set });
            if (done.count !== 1) throw new Error("quote change: a line was not there to change");
            items = change.remove ? items.filter((row) => row.id !== change.id) : items.map((row) => (row.id === change.id ? { ...row, ...set } : row));
          }
        }
        return finish(items, fees, {
          taxInclusive: existing.taxInclusive,
          depositType: existing.depositType === "percent" || existing.depositType === "amount" ? existing.depositType : null,
          depositValue: existing.depositValue,
        });
      }
      // CHANGING the customer is refused; FILLING IN a missing one is not. A
      // quote made from a lead with no customer yet used to be stuck: the editor
      // locked the box and this refused any value, so it could never get one.
      if (existing.leadId && existing.contactId && existing.contactId !== data.contactId) {
        throw new Error("The customer on a lead-linked quote cannot be changed.");
      }
      // Same rule for a fleet account, for a stronger reason. createQuoteForFleet
      // checked that this contact is the fleet's manager or one of its members;
      // allowing the customer to be swapped afterwards would route around that
      // check and leave the fleet's name, registration number and VAT number
      // printing beside an unrelated person. Rebinding is a new quote.
      if (existing.fleetId && existing.contactId !== data.contactId) {
        throw new Error("The customer on a fleet quote cannot be changed. Create a new quote instead.");
      }
      // #15: requireQuoteAccess only authorized the quote. Moving an existing
      // quote onto a DIFFERENT contact requires access to that destination too,
      // or a user could re-file their quote against a customer they can't access.
      if (existing.contactId !== data.contactId) {
        await requireContactAccess(data.contactId, "quotes.edit");
      }

      // updateMany + count check, not update(): existing was already read back
      // tenant-scoped above, so this is belt on top of braces — but a plain
      // update() throws Prisma's own not-found error on a zero-row match rather
      // than the refusal this action returns everywhere else, and every other
      // write in this transaction earns its predicate the same way.
      const updated = await tx.quote.updateMany({
        where: { id: existing.id, tenantId: actingTenant },
        data: {
          contactId: data.contactId,
          validUntil,
          terms: data.terms || null,
          status: data.intent,
          ...cpqQuoteData,
        },
      });
      // Every predicate above narrowed to a row that resolved as A's; this is
      // the point they all existed to protect, and a concurrent delete/purge
      // between the read and here is the only way it legitimately trips.
      if (updated.count !== 1) return null;
      // The lead was missing the same customer; give it this one too, so the
      // next quote made from it starts linked.
      if (existing.leadId && !existing.contactId && data.contactId) {
        await tx.lead.updateMany({
          where: { id: existing.leadId, contactId: null, tenantId: existing.tenantId ?? actingTenant },
          data: { contactId: data.contactId },
        });
      }

      // Inherit the hidden columns by row id, and KEEP that id — see quoteRows.
      const itemRows = itemRowsFor(normalizedItems, priorById(existing.items), createDefaults.regional.vatRatePct);
      const feeRows = feeRowsFor(normalizedFees, priorById(existing.fees), createDefaults.regional.vatRatePct);
      // The QUOTE is the parent, so its children take ITS owner — the same
      // invariant createQuoteRevision applies to a copied quote. Stamping the
      // actor instead would split a quote across two workspaces whenever the
      // editor's acting tenant differs from the quote's, and this is a
      // `basePrisma` transaction: the RLS bypass, where no guard is left to
      // notice a parent and child disagreeing about who owns them. The acting
      // tenant survives only as the fallback for a quote that predates tenancy.
      const quoteTenantId = existing.tenantId ?? actingTenant;
      await tx.quoteItem.deleteMany({ where: { quoteId: existing.id } });
      if (itemRows.length > 0) {
        // Rewriting these through the bypass client without a stamp left every
        // line item and fee unowned.
        await tx.quoteItem.createMany({ data: itemRows.map((row) => ({ ...row, quoteId: existing.id, tenantId: quoteTenantId })) });
      }
      await tx.quoteFee.deleteMany({ where: { quoteId: existing.id } });
      if (feeRows.length > 0) {
        await tx.quoteFee.createMany({ data: feeRows.map((row) => ({ ...row, quoteId: existing.id, tenantId: quoteTenantId })) });
      }
      return finish(itemRows, feeRows, cpqQuoteData);
    }

    // A Confirm that already created its quote creates no second one.
    if (!(await claimConfirmKey(tx, "a new quote"))) return REPEATED;
    const number = await nextQuoteNumber(tx); // advisory-locked allocation (#11)

    // Same builders, with NOTHING to inherit from — so a client-supplied id
    // finds no prior row and is dropped rather than choosing a primary key.
    const itemRows = itemRowsFor(normalizedItems, new Map(), createDefaults.regional.vatRatePct);
    const feeRows = feeRowsFor(normalizedFees, new Map(), createDefaults.regional.vatRatePct);
    // A brand-new quote has no prior owner, so the actor IS the parent's owner
    // here — and the children take the same value, which is the same
    // parent-owns-child invariant the edit path above applies to an existing
    // quote. Nested creates inherit nothing in Prisma, hence the explicit stamp.
    const created = await tx.quote.create({
      data: {
        number,
        tenantId: actingTenant,
        contactId: data.contactId,
        leadId: linkedLeadId,
        createdById: user.id,
        validUntil: validUntil ?? createDefaults.validUntil,
        terms: data.terms || createDefaults.terms,
        status: data.intent,
        ...cpqQuoteData,
        items: itemRows.length > 0 ? { create: itemRows.map((row) => ({ ...row, tenantId: actingTenant })) } : undefined,
        fees: feeRows.length > 0 ? { create: feeRows.map((row) => ({ ...row, tenantId: actingTenant })) } : undefined,
      },
    });
    // ITS PDF, FOR THE PERSON WHO MADE IT — written in THIS transaction, so a
    // quote the assistant built and the record that gets its PDF to them exist
    // together or not at all. (Written after the quote instead, a failure there
    // left a quote with nothing for the retrying delivery to find.) It is an
    // update for the SIGNED-IN person only, sent to the phone they linked
    // themselves and re-verified at send time — never to a customer. A draft only.
    if (data.pdfToMyWhatsApp && data.intent === "draft") {
      const total = payableTotalCents({ items: itemRows, fees: feeRows, ...cpqQuoteData });
      await tx.assistantTurn.create({
        data: {
          tenantId: actingTenant,
          userId: user.id,
          source: QUOTE_PDF_SOURCE,
          quoteId: created.id,
          question: `Draft quote Q-${number}`,
          answer: `I've created draft quote Q-${number} (${formatZAR(Math.round(total))}). It has NOT been sent to the customer — sending it is your step.\n${quoteOrigin}/quotes?edit=${created.id}`,
        },
      });
    }
    return { quote: created, itemRows: itemRows as PricedItem[], feeRows: feeRows as PricedFee[], cpq: cpqQuoteData };
  }).catch((error: unknown) => {
    // Two Confirms of the same card at the same moment: the second one's key
    // collides on its primary key and its whole transaction is undone.
    if (data.confirmKey && typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002") return REPEATED;
    throw error;
  });

  if (result === STALE) {
    return { ok: false, error: "That quote has changed since this was suggested, so nothing was changed. Ask again to see it as it is now." };
  }
  if (result === REPEATED) {
    return { ok: false, error: "That was already confirmed — open the quote to see it. Nothing was added twice.", repeated: true };
  }
  if (!result) {
    return {
      ok: false,
      error: "This quote is locked or no longer editable. Refresh to see its latest state.",
    };
  }

  const { quote: saved, itemRows, feeRows, cpq } = result;
  // The figure that lands in the audit trail as the value of this quote — so it
  // is the payable total, fees and delivery included, not the line subtotal.
  //
  // Computed from the rows as PERSISTED, not from the request. `normalizedItems`
  // carries no optional/selected, so quotePricing counted every line: a quote
  // with an add-on the customer had declined recorded a sale worth more than
  // the database, the preview and the printed document all say it is.
  const total = payableTotalCents({ items: itemRows, fees: feeRows, ...cpq });
  await logAudit({
    action: data.intent === "sent" ? "quote.sent" : data.id ? "quote.updated" : "quote.created",
    summary:
      data.intent === "sent"
        ? `Quote Q-${saved.number} (${formatZAR(Math.round(total))}) marked sent to the customer`
        : `${data.id ? "Updated" : "Created"} quote Q-${saved.number} for ${contactName(contact)}`,
    leadId: saved.leadId,
    contactId: data.contactId,
    user,
  });

  revalidatePath("/quotes");
  revalidatePath(`/quotes/${saved.id}`);
  return {
    ok: true,
    quote: {
      id: saved.id,
      number: saved.number,
      status: saved.status,
      updatedAt: saved.updatedAt.toISOString(),
    },
  };
  });
}

/**
 * Bound with {@link withActingStaffScope} because this action reads the tenant scope
 * SYNCHRONOUSLY (inheritedTenantId / activeTenantPredicate / writeTenantId), and a
 * sync reader cannot recover a missing scope the way an awaited one can.
 *
 * A Server Action has no React request store, so #513's holder is never filled, and
 * `enterWith` inside the auth chokepoint does not reach the frame that called it —
 * the action body therefore runs with no ambient scope and the sync reader throws.
 * Binding an ENCLOSING frame here is the only shape that reaches it.
 */
export async function createQuoteRevision(quoteId: string) {
  return withActingStaffScope(async () => {
  return asActionResult(async () => {
    const user = await requireQuoteAccess(quoteId, "quotes.edit");
    const { validUntil } = await quoteFromLeadDefaults();
    // The ACTING workspace, and here it is a PREDICATE, not just a fallback owner.
    // `actingTenantId()` resolves the validated session workspace while enforcement
    // is dormant, which `writeTenantId()` does not — dormant is every environment
    // we run, so this is the only value that names the right workspace today.
    const actingTenant = await actingTenantId();

    // One transaction: lock the original FOR UPDATE so two concurrent revision
    // requests can't both spawn a revision (the loser re-reads supersededAt set and
    // bails), allocate the number under the advisory lock (#11), copy ALL commercial
    // data — items with discount/tax/cost/optional/selected/sort, fees, tax mode and
    // deposit (the old copy dropped everything but description/qty/price/product/
    // colour, #10) — then supersede the original. All commit together.
    //
    // AND ONLY A QUOTE THIS WORKSPACE OWNS. This is a `basePrisma` transaction —
    // the RLS bypass — and `requireQuoteAccess` above authorises the quote against
    // an access LIST whose tenant predicate is inert while enforcement is dormant,
    // so it said nothing about which workspace the row belongs to. Without the
    // predicate below, an admin in workspace A could revise workspace B's quote and
    // the copy was the smaller half of the damage: superseding the ORIGINAL makes it
    // read-only to its owner and kills its live signing link, and DELETES NOTHING,
    // so nothing that counts rows would ever have noticed. The predicate has to be
    // on the lock, the read AND the supersede — a filtered read in front of an
    // unfiltered update is not a boundary, it is a race (#459).
    const revision = await basePrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Quote" WHERE id = ${quoteId} AND "tenantId" = ${actingTenant} FOR UPDATE`;
      const original = await tx.quote.findFirst({
        where: { id: quoteId, tenantId: actingTenant },
        include: { items: true, fees: true },
      });
      if (!original || original.deletedAt || original.supersededAt || original.signedAt) return null;
      // A live signing request must be voided before revising — otherwise the
      // superseded quote would keep a live customer signing link.
      if (await hasOpenSignatureRequest(tx, quoteId)) return { blocked: true as const };

      const number = await nextQuoteNumber(tx);
      // A revision belongs to whoever owned the ORIGINAL, not to whoever happens
      // to be revising it — the acting workspace is only the fallback for a row
      // that predates tenancy. Copying without carrying this left every revision
      // and all of its copied children unowned.
      //
      // The read above now proves the two are the SAME workspace, so this is a
      // second layer rather than the boundary. It is kept in the inherit-from-the
      // -parent form deliberately: that is the rule for a child row, and writing
      // `actingTenant` here would read as "the reviser owns the copy", which is
      // the mistake this line exists to prevent.
      const tenantId = original.tenantId ?? actingTenant;
      const created = await tx.quote.create({
        data: {
          number,
          tenantId,
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
              tenantId,
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
              tenantId,
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
          data: cfValues.map((v) => ({ defId: v.defId, recordId: created.id, value: v.value, tenantId })),
        });
      }
      // THE ROW BEING CHANGED CARRIES THE PREDICATE. `update({ where: { id } })`
      // on the bypass client would supersede whatever row that id names; the
      // authorisation and the read that happened earlier are not a boundary on
      // THIS write. updateMany + a count check, so the boundary is expressed on
      // the statement that does the damage and a zero-row match is loud.
      const superseded = await tx.quote.updateMany({
        where: { id: original.id, tenantId: actingTenant, deletedAt: null, supersededAt: null, signedAt: null },
        data: { supersededAt: new Date(), signToken: null, signLinkCreatedAt: null, reminderSentAt: null },
      });
      // THROW, not return: the revision and every child row it copied are already
      // written in this transaction, and returning would commit them beside an
      // original that was never superseded — two live quotes for one deal.
      if (superseded.count !== 1) {
        throw new ActionRefusal("Could not create the revision — reload and try again.");
      }
      return { id: created.id, number: created.number, originalNumber: original.number, leadId: original.leadId, contactId: original.contactId };
    });

    if (!revision) refuse("Could not create the revision — reload and try again.");
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
    // A revision is a fresh DRAFT, and the point of making one is to change it.
    // Landing on the read-only record meant a second navigation before any work
    // could start — the same reason createQuoteFromLead opens the editor.
    return { redirectTo: `/quotes?edit=${revision.id}` };
  });
  });
}

/*
 * addQuoteItem, deleteQuoteItem and updateQuoteMeta lived here, alongside
 * actions/cpq.ts (addQuoteFee, deleteQuoteFee, setQuoteDeposit,
 * setQuoteTaxMode). All seven had exactly one caller: the quote record page.
 * That page is a redirect now, and the editor does the same work through
 * saveQuoteDraft, which writes the header, lines and fees in one locked
 * transaction rather than a request per field.
 *
 * Removed rather than left: a server action is a reachable endpoint, so an
 * unused one is not merely dead code but surface — permission-gated, but
 * untested and unexercised, which is how a guard rots without anyone noticing.
 */

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
    // ACCEPTING is the same act as "Mark won" with this quote chosen, so both go
    // through the one shared definition — quote accepted (which is what puts it on
    // Deliveries), lead won, both audited, in one locked transaction.
    if (status === "accepted") {
      const tenantId = await actingTenantId();
      const accepted = await basePrisma.$transaction(
        (tx) => acceptQuoteInTx(tx, quoteId, tenantId, user),
        GOVERNANCE_TX,
      );
      if (accepted.kind === "gone") refuse("This quote can no longer be changed — reload the page.");
      if (accepted.kind === "out_for_signature") {
        refuse("This quote is out for signature — void the signing request before changing its status.");
      }
      if (accepted.wonLeadId) await afterDealWon(accepted.wonLeadId, accepted.quote.contactId);
      revalidatePath("/quotes");
      revalidatePath(`/quotes/${quoteId}`);
      revalidatePath("/deliveries");
      if (accepted.quote.leadId) revalidatePath(`/leads/${accepted.quote.leadId}`);
      return { success: `Quote Q-${accepted.quote.number} accepted — it's on Deliveries` };
    }
    // Lock the quote FOR UPDATE and re-check signed/superseded inside the
    // transaction so a concurrent createQuoteRevision can't supersede it between
    // the check and the write.
    const result = await basePrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "Quote" WHERE id = ${quoteId} FOR UPDATE`;
      const before = await tx.quote.findUnique({ where: { id: quoteId } });
      // A cancelled quote is finished: Duplicate it to start again.
      if (!before || before.deletedAt || before.signedAt || before.supersededAt || before.status === "cancelled") return null;
      // Don't let staff manually decline a quote that's out for signature — void
      // the request first. (draft/sent moves are still allowed.)
      if (status === "declined" && (await hasOpenSignatureRequest(tx, quoteId))) {
        return { blocked: true as const };
      }
      const updated = await tx.quote.update({
        where: { id: quoteId },
        data: { status },
        // `fees` is not optional here: payableTotalCents() below writes the
        // figure into the audit trail, and without them it silently records
        // the line-items subtotal as the value of the sale.
        include: { items: true, fees: true, lead: true },
      });
      // Reopen the lead in the SAME transaction when this quote stops being accepted,
      // so the status change and the reopen are atomic.
      let reopenedLead: { title: string; contactId: string | null } | null = null;
      if (before.status === "accepted" && updated.leadId) {
        reopenedLead = await reopenLeadInTx(tx, updated.leadId);
      }
      return { beforeStatus: before.status, quote: updated, reopenedLead };
    });
    // The transaction returns null BEFORE touching anything when the quote is
    // missing, deleted, signed or superseded — so this is "nothing happened",
    // not a defensive check after a committed write. Returning normally reported
    // "Quote status updated" for a quote that had not changed.
    if (!result) refuse("This quote can no longer be changed — reload the page.");
    if ("blocked" in result) {
      throw new ActionRefusal("This quote is out for signature — void the signing request before changing its status.");
    }
    const { quote, reopenedLead } = result;
    const total = payableTotalCents(quote);
    const verb =
      status === "sent"
        ? "sent to the customer"
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
    // "Quote declined" is offered as an enrolment trigger in the journey
    // builder, and was offered by the retired automations builder before it,
    // and NEITHER engine ever fired it: nothing in the codebase called
    // runLeadAutomations("quote_declined", …) either. A rule or journey built on
    // it could never run. This is the only place a quote becomes declined.
    if (status === "declined" && quote.leadId) {
      await emitLeadJourneyEvent("quote_declined", quote.leadId, {
        // Keyed on the quote: declining does not touch the lead row, and a quote
        // can go declined → draft → declined again, which must enrol twice.
        occurrence: `quote:${quoteId}:declined:${quote.updatedAt.toISOString()}`,
        payload: { quoteId, quoteNumber: quote.number },
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

/**
 * One quote, in the shape the editor opens.
 *
 * The editor could only ever open a quote the quotes LIST had already rendered,
 * which was fine while a row click was the only way in. A revision creates an id
 * that by definition is not in that list yet, so the editor opened it blank; the
 * list is also capped at 200, so a deep link to an older quote did the same.
 *
 * Read access only — every mutation the editor offers re-checks its own
 * permission. Returns null rather than redirecting: this feeds a dialog, not a
 * page, and requireQuoteReadAccess() throws NEXT_REDIRECT.
 */
export async function quoteEditorRecord(id: string): Promise<QuoteEditorRecord | null> {
  return withActingStaffScope(async () => {
    const user = await getCurrentUser();
    if (!user) return null;
    if (!(await hasAnyPermission(user, "quotes.view_all", "quotes.view_owned"))) return null;
    if (!(await canAccessQuote(user, id))) return null;

    const quote = await prisma.quote.findUnique({ where: { id }, include: QUOTE_EDITOR_INCLUDE });
    if (!quote || quote.deletedAt) return null;

    // The version family: every revision reachable from this one, so the Versions
    // tab and the superseded-successor link work the same as from the list.
    // Loaded by family, not "the oldest 2,000 rows", which lost newer quotes' history.
    const versions = await loadQuoteVersions(prisma, [quote.id]);
    // Tenant-scoped, so a fleet id from another workspace resolves to nothing and
    // the quote reads as an ordinary customer quote rather than naming an account
    // this caller has no business seeing.
    const fleets = await loadBillToFleets(prisma, [quote.fleetId]);
    return buildQuoteEditorRecord(
      quote,
      quoteVersionIndex(versions),
      new Map([...fleets].map(([id, fleet]) => [id, fleet.name])),
      await getRegionalSettings(),
    );
  });
}

/**
 * May the caller trash THIS quote?
 *
 * Exactly the pair deleteQuote() enforces — the `quotes.delete` permission AND
 * access to this specific quote — asked ahead of the click so the control can
 * be greyed out instead of failing on use. It decides nothing: deleteQuote()
 * still runs the same check, and this returning true would not make a refused
 * delete succeed.
 */
export async function canDeleteQuote(id: string): Promise<boolean> {
  return withActingStaffScope(async () => {
    const user = await getCurrentUser();
    if (!user) return false;
    if (!(await hasPermission(user, "quotes.delete"))) return false;
    return canAccessQuote(user, id);
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
    return { redirectTo: "/quotes" };
  });
}

/**
 * Cancel a quote — signed or not — keeping everything it produced. The same
 * permission as the other lifecycle moves (accept / decline / back to draft);
 * the work itself is {@link cancelQuoteInTx}.
 */
export async function cancelQuote(id: string, formData: FormData) {
  return withActingStaffScope(async () => {
  return asActionResult(async () => {
    const user = await requireQuoteAccess(id, "quotes.change_status");
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reason) refuse("Say why the quote is being cancelled.");
    const tenantId = await actingTenantId();
    const result = await basePrisma.$transaction(async (tx) => {
      const cancelled = await cancelQuoteInTx(tx, { quoteId: id, tenantId, reason, actor: user });
      if (cancelled.kind !== "cancelled") return { cancelled, reopenedLead: null };
      // An accepted quote was the sale; cancelling it un-wins the lead unless
      // another accepted quote still stands — same rule as trashing one.
      const reopenedLead =
        cancelled.wasAccepted && cancelled.quote.leadId ? await reopenLeadInTx(tx, cancelled.quote.leadId) : null;
      return { cancelled, reopenedLead };
    }, GOVERNANCE_TX);
    const { cancelled, reopenedLead } = result;
    if (cancelled.kind !== "cancelled") refuse(cancelled.message);
    for (const unit of cancelled.releasedUnits) {
      await addStockEvent({
        stockUnitId: unit.id,
        eventType: unit.to === "available" ? "reservation.released" : "unit.status_changed",
        fromStatus: unit.from,
        toStatus: unit.to,
        leadId: unit.leadId,
        quoteId: id,
        reason: `Quote Q-${cancelled.quote.number} cancelled`,
        actor: { id: user.id, name: user.name },
      });
    }
    if (reopenedLead && cancelled.quote.leadId) {
      await auditLeadReopened(reopenedLead, cancelled.quote.leadId, cancelled.quote.number, user);
    }
    revalidatePath("/quotes");
    revalidatePath(`/quotes/${id}`);
    revalidatePath("/deliveries");
    revalidatePath("/stock");
    if (cancelled.quote.leadId) revalidatePath(`/leads/${cancelled.quote.leadId}`);
    if (cancelled.quote.contactId) revalidatePath(`/contacts/${cancelled.quote.contactId}`);
    return { success: `Quote Q-${cancelled.quote.number} cancelled` };
  });
  });
}

/**
 * A new, unsigned draft copy of a quote, opened in the editor. Same permission
 * as creating a quote, on a quote the caller can access — the shape
 * createQuoteRevision uses for its copy.
 */
export async function duplicateQuote(id: string) {
  return withActingStaffScope(async () => {
  return asActionResult(async () => {
    const user = await requireQuoteAccess(id, "quotes.create");
    // A fresh expiry — today + validity on the WORKSPACE calendar, the same
    // default every new quote and revision gets — never the original's date.
    const { validUntil } = await quoteFromLeadDefaults();
    const tenantId = await actingTenantId();
    const copy = await basePrisma.$transaction(
      (tx) => duplicateQuoteInTx(tx, { quoteId: id, tenantId, actor: user, validUntil }),
      GOVERNANCE_TX,
    );
    if (!copy) refuse("That quote is no longer available — reload the page.");
    revalidatePath("/quotes");
    if (copy.leadId) revalidatePath(`/leads/${copy.leadId}`);
    if (copy.contactId) revalidatePath(`/contacts/${copy.contactId}`);
    return { success: `Quote Q-${copy.number} created from Q-${copy.originalNumber}`, redirectTo: `/quotes?edit=${copy.id}` };
  });
  });
}
