import "server-only";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { refuse } from "@/lib/actionResult";
import { logAudit } from "@/lib/audit";
import { ciExactIds } from "@/lib/ciExact";
import { emitLeadJourneyEvent } from "@/lib/leadJourneyEvents";
import { deliveryHandoverReadiness } from "@/lib/checklists/deliveryHandover";
import {
  DELIVERABLE_STATUS,
  DELIVERED_STOCK_STATUSES,
  notReadyMessage,
  vehiclesAwaitingRegistration,
  vinConflictMessage,
  vinMatch,
  type VinMatch,
} from "@/lib/deliveryVehicles";
import { addStockEvent } from "@/lib/stockPlatform";
import { deleteFile, saveFile } from "@/lib/storage";
import { logError } from "@/lib/errorLog";
import { withStagedEvidence, type StageFile } from "@/lib/stagedEvidence";
import type { PermissionUser } from "@/lib/permissions";

/**
 * THE ONE DELIVERY. Both "Mark delivered" on the Deliveries board and "Complete
 * delivery" on a stock unit end here, so whichever button is pressed:
 *
 *   - the quote is marked delivered (deliveredAt),
 *   - every stock unit allocated to the quote moves to "delivered", and
 *   - each unit has exactly ONE customer vehicle — an existing vehicle with the
 *     same VIN is reused rather than a second one created.
 *
 * There used to be two flows that each did half of this. The board marked the
 * quote delivered and left its stock "allocated" forever; the stock page
 * delivered the unit and created a vehicle but left the quote on the board, where
 * marking it delivered sent the customer to register the same cart a second time.
 *
 * The callers authorise (each keeps its own permission, exactly as before) and
 * resolve the acting tenant; everything from the gates to the audit is here.
 */

export const QUOTE_GONE = "This quote is no longer available in this workspace.";
export type DeliveryEvidence = {
  deliveredByName?: string | null;
  deliveryChecklist?: object;
  deliverySignatureRef?: string | null;
};

type QuoteForEvidence = { id: string; number: number; contactId: string | null; tenantId: string | null };

export async function deliverQuote(input: {
  quoteId: string;
  /** The ACTING tenant, resolved by the caller inside its action scope. */
  tenantId: string;
  user: PermissionUser;
  /** Guided-handover runs the customer signed beside (see markDelivered). */
  handoverRunIds?: readonly string[];
  warrantyMonths?: number;
  /**
   * The caller's paperwork (delivery note, signature). Runs AFTER every gate.
   * Files go through `stage`, which only uploads the blob: its Document row is
   * created inside the delivery transaction, and if the delivery fails for any
   * reason the blobs this attempt uploaded are deleted (lib/stagedEvidence.ts).
   */
  collectEvidence?: (quote: QuoteForEvidence, stage: StageFile) => Promise<DeliveryEvidence>;
}): Promise<{ redirectTo: string }> {
  const { quoteId, tenantId, user } = input;
  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, tenantId },
    // `items` so the delivery knows how many vehicles it actually sold. It used
    // to send the customer to register exactly one, whatever the quantity —
    // Q-1014 sold two Rover XXLs and the second was never recorded.
    include: {
      contact: true,
      lead: { include: { contact: true } },
      items: { include: { product: true }, orderBy: { sortOrder: "asc" } },
    },
  });
  if (!quote) refuse(QUOTE_GONE);

  const units = await prisma.stockUnit.findMany({
    where: { soldQuoteId: quoteId, tenantId, deletedAt: null },
    include: { product: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const outstanding = units.filter((unit) => !(DELIVERED_STOCK_STATUSES as readonly string[]).includes(unit.status));

  /*
   * A quote that is ALREADY delivered with stock still outstanding is the other
   * flow's leftover — the board delivered it before the two were joined, and its
   * cart was left "allocated". Finishing that unit is the only thing left to do,
   * and the handover gates below were satisfied when the quote was delivered.
   */
  const catchUp = Boolean(quote.deliveredAt);
  if (catchUp && outstanding.length === 0) refuse("This delivery is already marked as delivered.");

  /*
   * EVERY CART MUST BE READY, OR NOTHING IS DELIVERED.
   *
   * A cart still in PDI or on hold is not handed over by pressing a button on
   * the board. Refused here, before any write, naming each cart and why — so the
   * whole delivery either happens or does not. The transaction below re-checks
   * the status on every unit, so a unit that changes in between also refuses
   * the lot rather than delivering part of it.
   */
  const notReady = outstanding.filter((unit) => unit.status !== DELIVERABLE_STATUS);
  if (notReady.length > 0) refuse(notReadyMessage(quote.number, notReady));

  let deliveryHandoverRunIds: string[] = [];
  if (!catchUp) {
    if (!quote.deliveryScheduledFor) refuse("Schedule the delivery on the Deliveries board before marking it delivered.");

    /*
     * Re-verified, not trusted. Each id must be a COMPLETED run of this quote's
     * own delivery handover, in this tenant. Anything that does not resolve is a
     * caller passing ids it should not have, so the whole delivery is refused
     * rather than signed against a partial set — a delivery note showing three of
     * four checklists is worse than one that refuses to be produced.
     */
    const requestedRunIds = [...new Set(input.handoverRunIds ?? [])];
    let verifiedRuns: { id: string; templateId: string; completedAt: Date | null }[] = [];
    if (requestedRunIds.length) {
      verifiedRuns = await prisma.checklistRun.findMany({
        where: {
          id: { in: requestedRunIds },
          tenantId,
          hostType: "quote.delivery",
          hostId: quoteId,
          completedAt: { not: null },
        },
        select: { id: true, templateId: true, completedAt: true },
      });
      if (verifiedRuns.length !== requestedRunIds.length) {
        refuse("The handover checklists could not be confirmed. Reload the delivery and try again.");
      }
    }

    /*
     * THE GUIDED GATE, ENFORCED FOR EVERY CALLER.
     *
     * completeGuidedDelivery checks readiness before delegating, but the board's
     * markDelivered and the stock page's deliverStockUnit are exported Server
     * Actions — reachable by a stale legacy form or a hand-made request. The gate
     * lives here so no entry point can skip it: a stock-page delivery on a tenant
     * with a guided handover is refused and pointed at the delivery screen.
     *
     * Scoped to what the tenant has actually configured: no active template means
     * no guided handover, and the legacy proof-of-delivery flow is untouched.
     */
    const handoverTemplates = await prisma.checklistTemplate.findMany({
      where: { tenantId, host: "quote.delivery", active: true },
      select: { id: true, name: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    if (handoverTemplates.length > 0) {
      const readiness = deliveryHandoverReadiness(handoverTemplates, verifiedRuns);
      if (!readiness.ready) {
        const missing = handoverTemplates
          .filter((template) => readiness.missingTemplateIds.includes(template.id))
          .map((template) => template.name);
        refuse(
          `This delivery uses a guided handover. Complete ${missing.length === 1 ? `“${missing[0]}”` : missing.join(", ")} and sign from the delivery screen.`,
        );
      }
      if (verifiedRuns.length !== handoverTemplates.length) {
        refuse("The signed handover must include exactly one completed run for each active checklist. Reload the delivery and review it again.");
      }
    } else if (requestedRunIds.length > 0) {
      refuse("This delivery does not have an active guided handover. Reload the delivery and try again.");
    }

    const runByTemplate = new Map(verifiedRuns.map((run) => [run.templateId, run.id]));
    deliveryHandoverRunIds = handoverTemplates
      .map((template) => runByTemplate.get(template.id))
      .filter((id): id is string => Boolean(id));
  }

  /*
   * ONE VEHICLE PER CART — AND IT MUST BE THIS CUSTOMER'S. Resolved before
   * anything is written, so a refusal here costs nothing. A live vehicle with
   * the unit's serial (matched case-insensitively: stock serials are stored
   * upper-case, a hand-typed VIN may not be) is:
   *
   *   this quote's customer's  → reused;
   *   nobody's                 → attached to this customer, audited;
   *   ANOTHER customer's       → the whole delivery is refused. Never reassigned:
   *                              handing the cart over while its service and
   *                              warranty record stays on someone else is the
   *                              bug, and moving it silently is a worse one.
   */
  const contact = quote.contact ?? quote.lead?.contact ?? null;
  if (outstanding.length > 0 && !contact) {
    refuse("Link this quote to a contact before delivery — its stock becomes the customer's vehicle.");
  }
  const existingVehicle = new Map<string, { id: string; match: VinMatch; contactId: string }>();
  for (const unit of outstanding) {
    if (!unit.serial) continue;
    const ids = await ciExactIds("vehicleVin", unit.serial);
    if (ids.length === 0) continue;
    const live = await prisma.vehicle.findFirst({ where: { id: { in: ids } }, select: { id: true, contactId: true } });
    // The VIN is unique across the whole table. A match we cannot see is in
    // Trash, and creating another would collide with it.
    if (!live) refuse("A vehicle with this unit's serial/VIN already exists but is not active in this workspace (check Trash). Restore it, then deliver again.");
    const match = vinMatch(live.contactId, contact!.id);
    if (match === "conflict") refuse(vinConflictMessage(unit.serial));
    existingVehicle.set(unit.id, { id: live.id, match, contactId: live.contactId });
  }

  const deliveredAt = new Date();
  const warrantyMonths = Math.max(0, input.warrantyMonths ?? 12);
  const warrantyEndAt = warrantyMonths
    ? new Date(deliveredAt.getFullYear(), deliveredAt.getMonth() + warrantyMonths, deliveredAt.getDate())
    : null;

  /*
   * NOTHING ABOVE THIS POINT WRITES. Everything below either commits together
   * or leaves no record behind:
   *
   *   - evidence BLOBS are uploaded first under fresh random keys nothing
   *     references yet; if anything after that throws, exactly those blobs are
   *     deleted (withStagedEvidence);
   *   - their Document ROWS, the quote, its stock and its vehicles are written in
   *     ONE TRANSACTION. The quote update is conditional on it not being delivered
   *     yet, so two people pressing the two buttons at once cannot both deliver
   *     it — the second waits on the row lock, matches nothing, and is refused
   *     with every row rolled back;
   *   - audit, stock timeline and the journey event run only after the commit.
   */
  const vehicleIds = await withStagedEvidence(
    {
      save: (buffer, originalName, mimeType) => saveFile(buffer, originalName, mimeType, quote.tenantId),
      remove: deleteFile,
      // A count and an id only: the error itself may carry the blob's key.
      onCleanupFailure: (error, failed) =>
        logError(
          "delivery-evidence-cleanup",
          new Error(`${error instanceof Error ? error.name : "Error"}: ${failed} unreferenced delivery evidence file(s) could not be deleted`),
          `quote=${quoteId}`,
          { tenantId: quote.tenantId, alert: false },
        ),
    },
    async (stage) => (!catchUp && input.collectEvidence
      ? input.collectEvidence({ id: quote.id, number: quote.number, contactId: quote.contactId, tenantId: quote.tenantId }, stage)
      : {}),
    (evidence, documents) => prisma.$transaction(async (tx) => {
      if (!catchUp) {
        const updated = await tx.quote.updateMany({
          where: { id: quoteId, tenantId, deliveredAt: null },
          data: { deliveredAt, ...evidence, deliveryHandoverRunIds },
        });
        if (updated.count !== 1) refuse("This delivery was just completed by someone else. Refresh and check it.");
      }
      // The paperwork's rows commit or roll back WITH the delivery they evidence.
      // The quote owns them, as it owns its invoice and proof of payment.
      for (const document of documents) {
        await tx.document.create({
          data: {
            tenantId: quote.tenantId,
            ...document,
            contactId: quote.contactId,
            quoteId,
            uploadedById: user.id,
          },
        });
      }
      const ids: string[] = [];
      for (const unit of outstanding) {
        // Per-UNIT selling price for this one physical cart — NOT the whole quote
        // line (qty × price), which would over-state revenue for multi-quantity quotes.
        const saleLine = quote.items.find((item) => item.productId === unit.productId && item.selected);
        const moved = await tx.stockUnit.updateMany({
          where: { id: unit.id, status: DELIVERABLE_STATUS, deletedAt: null },
          data: {
            status: "delivered",
            soldAt: unit.soldAt ?? deliveredAt,
            deliveredAt,
            salePriceCents: saleLine ? Math.round(saleLine.unitPriceCents * (1 - saleLine.discountPct / 100)) : 0,
            warrantyStartAt: deliveredAt,
            warrantyEndAt,
          },
        });
        if (moved.count !== 1) refuse("A stock unit on this quote changed while it was being delivered. Refresh and try again.");
        const existing = existingVehicle.get(unit.id);
        if (existing) {
          // Re-proved INSIDE the transaction, conditional on the owner read above:
          // a vehicle transferred in between matches nothing and refuses the lot.
          const owned = existing.match === "attach"
            ? await tx.vehicle.updateMany({
                where: { id: existing.id, contactId: existing.contactId },
                data: { contactId: contact!.id },
              })
            : { count: await tx.vehicle.count({ where: { id: existing.id, contactId: contact!.id } }) };
          if (owned.count !== 1) refuse(vinConflictMessage(unit.serial ?? ""));
          ids.push(existing.id);
          continue;
        }
        const vehicle = await tx.vehicle.create({
          data: {
            model: unit.product.name,
            vin: unit.serial,
            color: unit.color,
            purchaseDate: deliveredAt,
            warrantyMonths: warrantyMonths || null,
            notes: `Created automatically from stock unit ${unit.stockNumber ?? unit.id}`,
            contactId: contact!.id,
            productId: unit.productId,
          },
          select: { id: true },
        });
        ids.push(vehicle.id);
      }
      return ids;
    }),
  );

  const actor = { id: user.id, name: user.name };
  for (const unit of outstanding) {
    const match = existingVehicle.get(unit.id)?.match;
    const outcome = match === "reuse"
      ? "existing vehicle record reused"
      : match === "attach"
        ? "existing unowned vehicle record attached to this customer"
        : "vehicle record created";
    await addStockEvent({
      stockUnitId: unit.id,
      eventType: "unit.delivered",
      fromStatus: unit.status,
      toStatus: "delivered",
      leadId: quote.leadId,
      quoteId,
      detail: outcome,
      actor,
    });
    if (match === "attach") {
      await logAudit({
        action: "vehicle.owner_attached",
        summary: `Vehicle …${(unit.serial ?? "").slice(-4)} had no owner; attached to this customer on delivery of Q-${quote.number}`,
        contactId: contact?.id ?? quote.contactId,
        leadId: quote.leadId,
        user,
      });
    }
    await logAudit({
      action: "stock.delivered",
      summary: `Delivered ${unit.stockNumber ?? unit.product.name} on Q-${quote.number} — ${outcome}`,
      contactId: contact?.id ?? quote.contactId,
      leadId: quote.leadId,
      user,
    });
  }
  if (!catchUp) {
    if (quote.leadId) {
      await emitLeadJourneyEvent("delivered", quote.leadId, {
        occurrence: `quote:${quoteId}:delivered`,
        payload: { quoteId, quoteNumber: quote.number },
      });
    }
    await logAudit({
      action: "fulfilment.delivered",
      summary: `Q-${quote.number} delivered 🎉${outstanding.length ? ` — ${outstanding.length} stock unit${outstanding.length === 1 ? "" : "s"} handed over` : ""}`,
      contactId: quote.contactId,
      leadId: quote.leadId,
      user,
    });
  }

  revalidatePath("/deliveries");
  revalidatePath(`/quotes/${quoteId}`);
  revalidatePath("/stock");
  for (const unit of units) revalidatePath(`/stock/${unit.id}`);
  revalidatePath("/vehicles");
  if (contact) revalidatePath(`/contacts/${contact.id}`);

  /*
   * Hand over the WHOLE queue, by pointing at the quote rather than at one
   * vehicle's details. The registration page re-derives the queue from the same
   * lines (minus the carts that came out of stock and already have a vehicle),
   * so the URL cannot carry a stale or hand-edited list.
   */
  const fromStock = units.map((unit) => ({ productId: unit.productId }));
  const queue = vehiclesAwaitingRegistration(quote.items, fromStock);
  const contactParam = `contactId=${quote.contactId ?? ""}`;
  if (queue.length > 0) return { redirectTo: `/vehicles/new?${contactParam}&quoteId=${quoteId}&seq=0` };
  if (vehicleIds.length > 0) return { redirectTo: `/vehicles/${vehicleIds[0]}` };
  // Every cart came out of stock and was delivered earlier: nothing to register.
  if (units.length > 0) return { redirectTo: `/stock/${units[0].id}` };
  // A quote with no catalogue lines and no stock queues nothing, and keeps the
  // previous behaviour — a blank registration form seeded with the contact.
  return {
    redirectTo: `/vehicles/new?${contactParam}&productId=${quote.lead?.productId ?? ""}&color=${encodeURIComponent(quote.lead?.color ?? "")}`,
  };
}

/** The registration queue for a delivered quote — lines minus carts delivered from stock. */
export async function registrationQueueForQuote(quoteId: string) {
  const quote = await prisma.quote.findFirst({
    where: { id: quoteId },
    include: {
      items: { include: { product: true }, orderBy: { sortOrder: "asc" } },
      soldStock: {
        where: { deletedAt: null, status: { in: [...DELIVERED_STOCK_STATUSES] } },
        select: { productId: true },
      },
    },
  });
  return quote ? vehiclesAwaitingRegistration(quote.items, quote.soldStock) : [];
}
