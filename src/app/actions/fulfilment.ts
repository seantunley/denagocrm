"use server";

import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { withActingStaffScope } from "@/lib/actingScope";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { actingTenantId } from "@/lib/actingTenant";
import { customerRecordTenantId } from "@/lib/customerRecordTenant";
import { requireQuoteAccess } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { emitLeadJourneyEvent } from "@/lib/leadJourneyEvents";
import { assertOwnedBlob, deleteFile, deleteOwnedBlob, saveFile } from "@/lib/storage";
import { logError } from "@/lib/errorLog";
import { checkUploadPayload, MAX_PHOTOS } from "@/lib/photoBudget";
import { contactName } from "@/lib/format";
import { loadBillToFleet, quoteBillTo } from "@/lib/quoteBillTo";
import { isModuleEnabled, requireModuleEnabled } from "@/lib/modules/enabled";
import { deliveryHandoverReadiness } from "@/lib/checklists/deliveryHandover";
import { vehiclesAwaitingRegistration } from "@/lib/deliveryVehicles";

const MAX_FILE = 4 * 1024 * 1024;
const QUOTE_GONE = "This quote is no longer available in this workspace.";

/**
 * A Server Action needs the tenant scope bound around its whole body. Resolving
 * actingTenantId() inside the body is not enough under tenant enforcement: the
 * recovered scope from a nested helper does not propagate back up to later writes
 * in the action frame. Keep asActionResult outside the scope wrapper so a failure
 * while recovering the scope is still logged and returned with a reference.
 */
function asFulfilmentAction(
  body: () => Promise<void | ActionResult>,
  options: { scope?: string; context?: string; tenantId?: string | null } = {},
): Promise<ActionResult> {
  return asActionResult(() => withActingStaffScope(body), options);
}

async function attachStageDocument(
  quoteId: string,
  contactId: string | null,
  tag: string,
  fileName: string,
  file: File,
  userId: string,
  /** The QUOTE's owner, verbatim — this paperwork is the quote's, not the clerk's. */
  tenantId: string | null,
) {
  const buffer = Buffer.from(await file.arrayBuffer());
  const storedName = await saveFile(buffer, file.name || fileName, file.type || "application/pdf", tenantId);
  try {
    await prisma.document.create({
      data: {
        tenantId,
        fileName,
        storedName,
        mimeType: file.type || "application/pdf",
        sizeBytes: file.size,
        contactId,
        quoteId,
        tag,
        uploadedById: userId,
      },
    });
  } catch (error) {
    await deleteFile(storedName).catch(async (cleanupError) => {
      await logError(
        "delivery-photo-cleanup",
        cleanupError,
        `quote=${quoteId} original-write-failure=true`,
        { tenantId, alert: false },
      );
    });
    throw error;
  }
}

function pickFile(formData: FormData): File | null {
  const file = formData.get("file");
  return file && typeof file === "object" && (file as File).size > 0 ? (file as File) : null;
}

export async function markInvoiced(quoteId: string, formData: FormData) {
  return asFulfilmentAction(async () => {
    await requireModuleEnabled("automotive");
    const user = await requireQuoteAccess(quoteId, "deliveries.manage");
    const tenantId = await actingTenantId();
    const quote = await prisma.quote.findFirst({
      where: { id: quoteId, tenantId },
      include: { contact: true },
    });
    if (!quote) refuse(QUOTE_GONE);
    if (quote.status !== "accepted") refuse("Only an accepted quote can be invoiced.");
    if (quote.invoicedAt) refuse("This quote has already been invoiced.");
    const file = pickFile(formData);
    if (!file) refuse("Choose a file to upload.");
    if (file.size > MAX_FILE) refuse("That file is larger than 4 MB.");
    await attachStageDocument(quoteId, quote.contactId, "invoice", `Invoice — Q-${quote.number}${file.name ? ` — ${file.name}` : ".pdf"}`, file, user.id, quote.tenantId);
    const updated = await prisma.quote.updateMany({
      where: { id: quoteId, tenantId },
      data: { invoicedAt: new Date() },
    });
    if (updated.count !== 1) refuse(QUOTE_GONE);
    await logAudit({
      action: "fulfilment.invoiced",
      summary: `Q-${quote.number} invoiced — invoice filed${quote.contact ? ` for ${contactName(quote.contact)}` : ""}`,
      contactId: quote.contactId,
      leadId: quote.leadId,
      user,
    });
    revalidatePath("/deliveries");
    revalidatePath(`/quotes/${quoteId}`);
  });
}

export async function markDepositPaid(quoteId: string, formData: FormData) {
  return asFulfilmentAction(async () => {
    await requireModuleEnabled("automotive");
    const user = await requireQuoteAccess(quoteId, "deliveries.manage");
    const tenantId = await actingTenantId();
    const quote = await prisma.quote.findFirst({ where: { id: quoteId, tenantId } });
    if (!quote) refuse(QUOTE_GONE);
    if (!quote.invoicedAt) refuse("Invoice this quote before recording a deposit.");
    if (quote.depositPaidAt) refuse("The deposit is already recorded.");
    const file = pickFile(formData);
    if (!file) refuse("Choose a file to upload.");
    if (file.size > MAX_FILE) refuse("That file is larger than 4 MB.");
    await attachStageDocument(quoteId, quote.contactId, "pop", `Proof of payment — Q-${quote.number}${file.name ? ` — ${file.name}` : ".pdf"}`, file, user.id, quote.tenantId);
    const updated = await prisma.quote.updateMany({
      where: { id: quoteId, tenantId },
      data: { depositPaidAt: new Date() },
    });
    if (updated.count !== 1) refuse(QUOTE_GONE);
    await logAudit({
      action: "fulfilment.deposit_paid",
      summary: `Q-${quote.number} deposit received — proof of payment filed`,
      contactId: quote.contactId,
      leadId: quote.leadId,
      user,
    });
    revalidatePath("/deliveries");
    revalidatePath(`/quotes/${quoteId}`);
  });
}

export async function scheduleDelivery(quoteId: string, formData: FormData) {
  return asFulfilmentAction(async () => {
    await requireModuleEnabled("automotive");
    const user = await requireQuoteAccess(quoteId, "deliveries.manage");
    const tenantId = await actingTenantId();
    const quote = await prisma.quote.findFirst({
      where: { id: quoteId, tenantId },
      include: { contact: true, lead: { include: { product: true } }, items: true },
    });
    if (!quote) refuse(QUOTE_GONE);
    if (!quote.depositPaidAt) refuse("Record the deposit before scheduling delivery.");
    if (quote.deliveryScheduledFor) refuse("Delivery is already scheduled.");
    const dateRaw = String(formData.get("date") ?? "").trim();
    if (!dateRaw) refuse("Choose a delivery date.");
    const when = new Date(dateRaw);
    if (isNaN(when.getTime())) refuse("That delivery date is not valid.");
    const file = pickFile(formData);
    if (file && file.size > MAX_FILE) refuse("That delivery paperwork is larger than 4 MB.");
    if (file) {
      await attachStageDocument(quoteId, quote.contactId, "delivery-note", `Delivery paperwork — Q-${quote.number} — ${file.name}`, file, user.id, quote.tenantId);
    }
    const model = quote.lead?.product?.name ?? quote.items[0]?.description ?? "cart";
    const who = quoteBillTo(quote, await loadBillToFleet(prisma, quote.fleetId)).name;
    const updated = await prisma.quote.updateMany({
      where: { id: quoteId, tenantId },
      data: { deliveryScheduledFor: when },
    });
    if (updated.count !== 1) refuse(QUOTE_GONE);
    await prisma.activity.create({
      data: {
        type: "todo",
        category: "workshop",
        summary: `🚚 Delivery — ${model} to ${who}`,
        note: `Fulfilment of quote Q-${quote.number}.`,
        dueDate: when,
        assignedToId: user.id,
        createdById: user.id,
        contactId: quote.contactId,
        leadId: quote.leadId,
        tenantId: await customerRecordTenantId({ contactId: quote.contactId, leadId: quote.leadId }),
      },
    });
    await logAudit({
      action: "fulfilment.delivery_scheduled",
      summary: `Q-${quote.number} delivery scheduled for ${when.toLocaleDateString("en-ZA")} — on the workshop calendar`,
      contactId: quote.contactId,
      leadId: quote.leadId,
      user,
    });
    revalidatePath("/deliveries");
    revalidatePath(`/quotes/${quoteId}`);
    revalidatePath("/workshop-calendar");
  });
}

export type StagedDeliveryPhoto = { url: string };

export async function registerDeliveryPhotos(
  quoteId: string,
  staged: StagedDeliveryPhoto[],
): Promise<ActionResult> {
  const failureLog: { scope: string; context: string; tenantId?: string | null } = {
    scope: "delivery-photo-finalize",
    context: `quote=${quoteId}`,
  };
  return asFulfilmentAction(async () => {
    const tenantId = await actingTenantId();
    failureLog.tenantId = tenantId;
    const user = await requireQuoteAccess(quoteId, "deliveries.manage");
    if (!(await isModuleEnabled("automotive"))) refuse("The automotive pack is switched off.");
    const quote = await prisma.quote.findFirst({ where: { id: quoteId, tenantId } });
    if (!quote?.tenantId) refuse(QUOTE_GONE);

    const urls = [...new Set(staged.map((item) => String(item.url ?? "").trim()).filter(Boolean))];
    if (urls.length === 0) refuse("Choose at least one photo.");
    if (urls.length > MAX_PHOTOS) refuse(`Upload up to ${MAX_PHOTOS} delivery photos at a time.`);

    // One definition, used to admit the photo AND to bound the cleanup below.
    // Two copies of this string would let the two checks drift apart.
    const ownPrefix = `uploads/${quote.tenantId}/delivery/${quote.id}/`;
    let saved = 0;
    let failed = 0;
    for (const [index, url] of urls.entries()) {
      try {
        const blob = await assertOwnedBlob(url, quote.tenantId);
        if (!blob.contentType.startsWith("image/")) throw new Error("Stored delivery evidence is not an image.");
        if (blob.size <= 0 || blob.size > MAX_FILE) throw new Error("Stored delivery photo is outside the 4 MB limit.");
        if (!blob.pathname.startsWith(ownPrefix)) {
          throw new Error("Stored delivery photo is not bound to this quote.");
        }
        await prisma.document.create({
          data: {
            tenantId: quote.tenantId,
            fileName: `Delivery photo — Q-${quote.number} — ${index + 1}`,
            storedName: url,
            mimeType: blob.contentType,
            sizeBytes: blob.size,
            contactId: quote.contactId,
            quoteId,
            tag: "delivery-photo",
            uploadedById: user.id,
          },
        });
        saved++;
      } catch (error) {
        failed++;
        await logError(
          "delivery-photo-finalize",
          error,
          `quote=${quoteId} photo=${index + 1}/${urls.length}`,
          { tenantId: quote.tenantId, alert: false },
        );
        // NOT deleteFile(url). The failure being handled here may be that the
        // URL belongs to ANOTHER workspace, and deleteFile has no tenant check —
        // it would delete with our own credentials, undoing the refusal that put
        // us in this catch. deleteOwnedBlob re-proves ownership and the record
        // binding first, and refuses instead of deleting when either fails.
        await deleteOwnedBlob(url, quote.tenantId, ownPrefix).catch(async (cleanupError) => {
          await logError("delivery-photo-cleanup", cleanupError, `quote=${quoteId} photo=${index + 1}`, {
            tenantId: quote.tenantId,
            alert: false,
          });
        });
      }
    }
    if (saved === 0) {
      refuse("The photos were uploaded but could not be filed. See Settings → System Log under delivery-photo-finalize.");
    }
    await logAudit({
      action: "fulfilment.photos",
      summary: `${saved} delivery photo${saved === 1 ? "" : "s"} added to Q-${quote.number}`,
      contactId: quote.contactId,
      leadId: quote.leadId,
      user,
    });
    revalidatePath("/deliveries");
    revalidatePath(`/quotes/${quoteId}`);
    return {
      success: failed
        ? `${saved} photo${saved === 1 ? "" : "s"} uploaded — ${failed} failed and were logged`
        : `${saved} photo${saved === 1 ? "" : "s"} uploaded`,
    };
  }, failureLog);
}

export async function uploadDeliveryPhotos(quoteId: string, formData: FormData) {
  // Server Actions do not inherit the page's tenant scope. Resolve the acting
  // workspace before any operation that can fail and share this mutable options
  // object with asActionResult, so the eventual ErrorLog row is visible in that
  // workspace rather than being filed as an unattributed platform error.
  const failureLog: { scope: string; context: string; tenantId?: string | null } = {
    scope: "delivery-photo-upload",
    context: `quote=${quoteId}`,
  };
  return asFulfilmentAction(async () => {
    const tenantId = await actingTenantId();
    failureLog.tenantId = tenantId;
    const user = await requireQuoteAccess(quoteId, "deliveries.manage");
    if (!(await isModuleEnabled("automotive"))) refuse("The automotive pack is switched off.");
    const quote = await prisma.quote.findFirst({ where: { id: quoteId, tenantId } });
    if (!quote) refuse(QUOTE_GONE);
    const files = formData.getAll("files").filter(
      (file): file is File => typeof file === "object" && (file as File).size > 0
    );
    if (files.length === 0) refuse("Choose at least one photo.");

    const accepted = files.filter((file) => file.size <= MAX_FILE && file.type.startsWith("image/"));
    if (accepted.length === 0) {
      refuse("None of those files could be used — photos must be images under 4 MB.");
    }
    const payload = checkUploadPayload(accepted.slice(0, MAX_PHOTOS).map((file) => file.size), {
      maxPhotos: MAX_PHOTOS,
      maxPerFile: MAX_FILE,
    });
    if (!payload.ok) refuse(payload.reason);

    let saved = 0;
    let failed = 0;
    for (const [index, file] of accepted.slice(0, MAX_PHOTOS).entries()) {
      try {
        await attachStageDocument(quoteId, quote.contactId, "delivery-photo", `Delivery photo — Q-${quote.number} — ${file.name}`, file, user.id, quote.tenantId);
        saved++;
      } catch (error) {
        failed++;
        await logError(
          "delivery-photo-upload",
          error,
          `quote=${quoteId} photo=${index + 1}/${Math.min(accepted.length, MAX_PHOTOS)} type=${file.type || "unknown"} bytes=${file.size}`,
          { tenantId: quote.tenantId, alert: false },
        );
      }
    }
    if (saved === 0) {
      refuse("The photos could not be stored. The technical reason is now available in Settings → System Log under delivery-photo-upload.");
    }
    const rejected = files.length - accepted.length;
    const overCap = Math.max(0, accepted.length - MAX_PHOTOS);
    const skipped = rejected + overCap + failed;
    if (saved > 0) {
      await logAudit({
        action: "fulfilment.photos",
        summary: `${saved} delivery photo${saved !== 1 ? "s" : ""} added to Q-${quote.number}`,
        contactId: quote.contactId,
        leadId: quote.leadId,
        user,
      });
    }
    revalidatePath("/deliveries");
    revalidatePath(`/quotes/${quoteId}`);
    return {
      success:
        skipped > 0
          ? `${saved} photo${saved === 1 ? "" : "s"} uploaded — ${skipped} skipped (not an image, over 4 MB, or past the ${MAX_PHOTOS}-photo limit)`
          : `${saved} photo${saved === 1 ? "" : "s"} uploaded`,
    };
  }, failureLog);
}

/**
 * `handoverRunIds` — the guided checklist runs the customer is signing BESIDE.
 *
 * THIS IS AN EXPORTED SERVER ACTION, WHICH IS A PUBLIC POST ENDPOINT, AND ITS
 * ARGUMENTS COME FROM THE CLIENT. An earlier version of this comment claimed the
 * ids were "passed server-to-server, never off the form" — that is wrong twice
 * over. A stale legacy form, or a hand-made request, can call this directly
 * without going anywhere near completeGuidedDelivery; and a Server Action's
 * arguments are deserialised from the request, so a caller can supply this third
 * parameter as freely as any form field.
 *
 * So the guided-handover gate cannot live only in completeGuidedDelivery. It is
 * enforced HERE, against the database, for every caller:
 *
 *  - every id must be a COMPLETED run of THIS quote's delivery handover, in the
 *    acting tenant — a caller cannot name another workspace's run, or an
 *    unfinished one; and
 *  - when the tenant has any ACTIVE quote.delivery template, the verified runs
 *    must satisfy deliveryHandoverReadiness — every configured checklist has one.
 *
 * Re-verification alone was not enough: a crafted call could pass one genuine
 * run id while a second configured checklist was still unfinished, and be
 * recorded as a signed handover carrying partial evidence.
 *
 * A tenant with no active template is the legacy flow, unchanged: no ids, empty
 * column, and the delivery note falls back exactly as it does for deliveries
 * completed before this existed.
 *
 * Written in the SAME updateMany that records the delivery, so a signed handover
 * can never exist without the runs it was signed against.
 */
export async function markDelivered(
  quoteId: string,
  formData: FormData,
  handoverRunIds?: readonly string[],
): Promise<ActionResult> {
  return asFulfilmentAction(async () => {
    await requireModuleEnabled("automotive");
    const user = await requireQuoteAccess(quoteId, "deliveries.manage");
    const tenantId = await actingTenantId();
    const quote = await prisma.quote.findFirst({
      where: { id: quoteId, tenantId },
      // `items` so the delivery knows how many vehicles it actually sold. It used
      // to send the customer to register exactly one, whatever the quantity —
      // Q-1014 sold two Rover XXLs and the second was never recorded.
      include: { lead: true, items: { include: { product: true }, orderBy: { sortOrder: "asc" } } },
    });
    if (!quote) refuse(QUOTE_GONE);
    if (!quote.deliveryScheduledFor) refuse("Schedule the delivery before marking it delivered.");
    if (quote.deliveredAt) refuse("This delivery is already marked as delivered.");
    /*
     * BEFORE ANY SIDE EFFECT, and that ordering is the point.
     *
     * Everything below this writes: the delivery-note file, the signature
     * blob, and a Document row for each. Running the gate afterwards refused
     * the request correctly and still left an uploaded blob and a Document row
     * behind for a delivery that never completed — storage dirtied by a call
     * that was rejected, with nothing to clean it up.
     *
     * The gate only reads, so it can run first at no cost, and a refusal then
     * costs the caller nothing but the round trip.
     */
    /*
     * Re-verified, not trusted. Each id must be a COMPLETED run of this quote's
     * own delivery handover, in this tenant. Anything that does not resolve is a
     * caller passing ids it should not have, so the whole delivery is refused
     * rather than signed against a partial set — a delivery note showing three of
     * four checklists is worse than one that refuses to be produced.
     */
    const requestedRunIds = [...new Set(handoverRunIds ?? [])];
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
     * THE GUIDED GATE, ENFORCED HERE RATHER THAN ONLY IN THE WRAPPER.
     *
     * completeGuidedDelivery checks readiness before delegating, but this action
     * is exported and therefore reachable without it — by a stale legacy form or
     * a hand-made request. Checking only in the wrapper leaves the invariant
     * optional, which is the same as not having it.
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
    }

    const deliveryHandoverRunIds = verifiedRuns.map((run) => run.id);

    const file = pickFile(formData);
    if (file && file.size > MAX_FILE) refuse("That delivery note is larger than 4 MB.");
    if (file) {
      await attachStageDocument(quoteId, quote.contactId, "delivery-note", `Delivery note — Q-${quote.number} — ${file.name}`, file, user.id, quote.tenantId);
    }

    const deliveredByName = String(formData.get("deliveredByName") ?? "").trim() || null;
    let deliveryChecklist: object | undefined;
    try {
      const parsed = JSON.parse(String(formData.get("checklist") ?? ""));
      if (parsed && typeof parsed === "object") deliveryChecklist = parsed;
    } catch {}
    let deliverySignatureRef: string | null = null;
    const signature = String(formData.get("signature") ?? "");
    if (signature.startsWith("data:image/png;base64,")) {
      const buffer = Buffer.from(signature.split(",")[1], "base64");
      if (buffer.length > 0 && buffer.length <= MAX_FILE) {
        // The customer's signature on THIS quote's delivery — the quote owns it,
        // for the same reason its invoice and delivery note do.
        deliverySignatureRef = await saveFile(buffer, `delivery-signature-Q${quote.number}.png`, "image/png", quote.tenantId);
        await prisma.document.create({
          data: {
            tenantId: quote.tenantId,
            fileName: `Delivery signature — Q-${quote.number}`,
            storedName: deliverySignatureRef,
            mimeType: "image/png",
            sizeBytes: buffer.length,
            contactId: quote.contactId,
            quoteId,
            tag: "delivery-signature",
            uploadedById: user.id,
          },
        });
      }
    }



    const updated = await prisma.quote.updateMany({
      where: { id: quoteId, tenantId },
      data: { deliveredAt: new Date(), deliveredByName, deliveryChecklist, deliverySignatureRef, deliveryHandoverRunIds },
    });
    if (updated.count !== 1) refuse(QUOTE_GONE);
    if (quote.leadId) {
      await emitLeadJourneyEvent("delivered", quote.leadId, {
        occurrence: `quote:${quoteId}:delivered`,
        payload: { quoteId, quoteNumber: quote.number },
      });
    }
    await logAudit({
      action: "fulfilment.delivered",
      summary: `Q-${quote.number} delivered 🎉 — register the vehicle to start its service life`,
      contactId: quote.contactId,
      leadId: quote.leadId,
      user,
    });
    revalidatePath("/deliveries");
    revalidatePath(`/quotes/${quoteId}`);
    /*
     * Hand over the WHOLE queue, by pointing at the quote rather than at one
     * vehicle's details.
     *
     * `?quoteId=…&seq=0` keeps the quote as the single source of truth: the
     * registration page re-derives the queue from the same lines, so the URL
     * cannot carry a stale or hand-edited list, and the position survives a
     * refresh. The old link passed the LEAD's product, which was not even
     * necessarily what the quote sold.
     *
     * A quote with no catalogue lines queues nothing, and keeps the previous
     * behaviour — a blank registration form seeded with the contact.
     */
    const queue = vehiclesAwaitingRegistration(quote.items);
    const contactParam = `contactId=${quote.contactId ?? ""}`;
    return {
      redirectTo: queue.length > 0
        ? `/vehicles/new?${contactParam}&quoteId=${quoteId}&seq=0`
        : `/vehicles/new?${contactParam}&productId=${quote.lead?.productId ?? ""}&color=${encodeURIComponent(quote.lead?.color ?? "")}`,
    };
  });
}