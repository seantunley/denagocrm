"use server";

import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { withActingStaffScope } from "@/lib/actingScope";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { actingTenantId } from "@/lib/actingTenant";
import { customerRecordTenantId } from "@/lib/customerRecordTenant";
import { requireQuoteAccess } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { assertOwnedBlob, deleteFile, deleteOwnedBlob, saveFile } from "@/lib/storage";
import { logError } from "@/lib/errorLog";
import { checkUploadPayload, MAX_PHOTOS } from "@/lib/photoBudget";
import { contactName, formatZAR, parseRands } from "@/lib/format";
import { loadBillToFleet, quoteBillTo } from "@/lib/quoteBillTo";
import { isModuleEnabled, requireModuleEnabled } from "@/lib/modules/enabled";
import { deliverQuote, QUOTE_GONE, type DeliveryEvidence } from "@/lib/quoteDelivery";

const MAX_FILE = 4 * 1024 * 1024;

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
): Promise<string> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const storedName = await saveFile(buffer, file.name || fileName, file.type || "application/pdf", tenantId);
  try {
    const document = await prisma.document.create({
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
      select: { id: true },
    });
    return document.id;
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

/** A required rand amount, stored as integer cents like every other amount. */
function depositCents(formData: FormData): number {
  const raw = String(formData.get("amount") ?? "").trim();
  if (!raw) refuse("Enter the deposit amount received.");
  const cents = parseRands(raw);
  if (cents < 0) refuse("The deposit amount cannot be negative.");
  return cents;
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
    const amountCents = depositCents(formData);
    const file = pickFile(formData);
    if (!file) refuse("Choose a file to upload.");
    if (file.size > MAX_FILE) refuse("That file is larger than 4 MB.");
    await attachStageDocument(quoteId, quote.contactId, "pop", `Proof of payment — Q-${quote.number}${file.name ? ` — ${file.name}` : ".pdf"}`, file, user.id, quote.tenantId);
    const updated = await prisma.quote.updateMany({
      where: { id: quoteId, tenantId },
      data: { depositPaidAt: new Date(), depositPaidCents: amountCents },
    });
    if (updated.count !== 1) refuse(QUOTE_GONE);
    await logAudit({
      action: "fulfilment.deposit_paid",
      summary: `Q-${quote.number} deposit of ${formatZAR(amountCents)} received — proof of payment filed`,
      contactId: quote.contactId,
      leadId: quote.leadId,
      user,
    });
    revalidatePath("/deliveries");
    revalidatePath(`/quotes/${quoteId}`);
  });
}

/** Correct the recorded deposit amount — a typo must not be permanent. Audited old → new. */
export async function correctDepositAmount(quoteId: string, formData: FormData) {
  return asFulfilmentAction(async () => {
    await requireModuleEnabled("automotive");
    const user = await requireQuoteAccess(quoteId, "deliveries.manage");
    const tenantId = await actingTenantId();
    const quote = await prisma.quote.findFirst({ where: { id: quoteId, tenantId } });
    if (!quote) refuse(QUOTE_GONE);
    if (!quote.depositPaidAt) refuse("Record the deposit before correcting its amount.");
    const amountCents = depositCents(formData);
    if (amountCents === quote.depositPaidCents) return { success: "That is already the recorded amount" };
    const updated = await prisma.quote.updateMany({
      where: { id: quoteId, tenantId },
      data: { depositPaidCents: amountCents },
    });
    if (updated.count !== 1) refuse(QUOTE_GONE);
    await logAudit({
      action: "fulfilment.deposit_amount_corrected",
      summary: `Q-${quote.number} deposit amount changed from ${quote.depositPaidCents == null ? "not recorded" : formatZAR(quote.depositPaidCents)} to ${formatZAR(amountCents)}`,
      contactId: quote.contactId,
      leadId: quote.leadId,
      user,
    });
    revalidatePath("/deliveries");
    revalidatePath(`/quotes/${quoteId}`);
  });
}

/**
 * Replace a wrong invoice or proof of payment. The new file is filed exactly as
 * the original was (same private storage helper, same quote ownership); the old
 * one is NOT deleted — it is marked as replaced by the new one, the repository's
 * versioning link, so it stays in the quote's document history.
 */
async function replaceStageDocument(quoteId: string, formData: FormData, kind: "invoice" | "pop") {
  return asFulfilmentAction(async () => {
    await requireModuleEnabled("automotive");
    const user = await requireQuoteAccess(quoteId, "deliveries.manage");
    const tenantId = await actingTenantId();
    const quote = await prisma.quote.findFirst({ where: { id: quoteId, tenantId } });
    if (!quote) refuse(QUOTE_GONE);
    const label = kind === "invoice" ? "invoice" : "proof of payment";
    if (kind === "invoice" ? !quote.invoicedAt : !quote.depositPaidAt) refuse(`There is no ${label} on this quote to replace yet.`);
    const file = pickFile(formData);
    if (!file) refuse("Choose a file to upload.");
    if (file.size > MAX_FILE) refuse("That file is larger than 4 MB.");
    const previous = await prisma.document.findMany({
      where: { quoteId, tenantId: quote.tenantId, tag: kind, replacedById: null },
      select: { id: true },
    });
    const title = kind === "invoice" ? `Invoice — Q-${quote.number}` : `Proof of payment — Q-${quote.number}`;
    const nextId = await attachStageDocument(quoteId, quote.contactId, kind, `${title}${file.name ? ` — ${file.name}` : ".pdf"}`, file, user.id, quote.tenantId);
    if (previous.length) {
      await prisma.document.updateMany({
        where: { id: { in: previous.map((doc) => doc.id) }, quoteId },
        data: { replacedById: nextId },
      });
    }
    await logAudit({
      action: kind === "invoice" ? "fulfilment.invoice_replaced" : "fulfilment.pop_replaced",
      summary: `Q-${quote.number} ${label} replaced — the previous file is kept in the quote's document history`,
      contactId: quote.contactId,
      leadId: quote.leadId,
      user,
    });
    revalidatePath("/deliveries");
    revalidatePath(`/quotes/${quoteId}`);
    revalidatePath("/documents");
  });
}

export async function replaceInvoice(quoteId: string, formData: FormData) {
  return replaceStageDocument(quoteId, formData, "invoice");
}

export async function replaceProofOfPayment(quoteId: string, formData: FormData) {
  return replaceStageDocument(quoteId, formData, "pop");
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

/**
 * Move a scheduled delivery to another day. The workshop-calendar entry that
 * scheduleDelivery created moves with it (matched by the note it wrote, which is
 * the only link it has), and the change is audited old → new.
 */
export async function rescheduleDelivery(quoteId: string, formData: FormData) {
  return asFulfilmentAction(async () => {
    await requireModuleEnabled("automotive");
    const user = await requireQuoteAccess(quoteId, "deliveries.manage");
    const tenantId = await actingTenantId();
    const quote = await prisma.quote.findFirst({ where: { id: quoteId, tenantId } });
    if (!quote) refuse(QUOTE_GONE);
    const previous = quote.deliveryScheduledFor;
    if (!previous) refuse("Schedule the delivery before rescheduling it.");
    if (quote.deliveredAt) refuse("This delivery has already been completed.");
    const dateRaw = String(formData.get("date") ?? "").trim();
    if (!dateRaw) refuse("Choose the new delivery date.");
    const when = new Date(dateRaw);
    if (isNaN(when.getTime())) refuse("That delivery date is not valid.");
    if (when.getTime() === previous.getTime()) return { success: "That is already the delivery date" };
    // Conditional on the date we read, so two people rescheduling at once cannot
    // silently overwrite each other — the second is told to refresh.
    const updated = await prisma.quote.updateMany({
      where: { id: quoteId, tenantId, deliveredAt: null, deliveryScheduledFor: previous },
      data: { deliveryScheduledFor: when },
    });
    if (updated.count !== 1) refuse("The delivery changed while you were rescheduling it. Refresh and try again.");
    await prisma.activity.updateMany({
      where: {
        note: `Fulfilment of quote Q-${quote.number}.`,
        dueDate: previous,
        status: "planned",
        contactId: quote.contactId,
        leadId: quote.leadId,
      },
      data: { dueDate: when },
    });
    await logAudit({
      action: "fulfilment.delivery_rescheduled",
      summary: `Q-${quote.number} delivery moved from ${previous.toLocaleDateString("en-ZA")} to ${when.toLocaleDateString("en-ZA")}`,
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
 * The Deliveries board's "Mark delivered". Authorises, then hands over to the
 * ONE delivery (lib/quoteDelivery.ts → deliverQuote), which the stock page's
 * "Complete delivery" also uses — so the quote, its stock units and the
 * customer's vehicles end up the same whichever button was pressed.
 *
 * `handoverRunIds` — the guided checklist runs the customer is signing BESIDE.
 *
 * THIS IS AN EXPORTED SERVER ACTION, WHICH IS A PUBLIC POST ENDPOINT, AND ITS
 * ARGUMENTS COME FROM THE CLIENT. A stale legacy form, or a hand-made request,
 * can call this directly without going anywhere near completeGuidedDelivery; and
 * a Server Action's arguments are deserialised from the request, so a caller can
 * supply this third parameter as freely as any form field.
 *
 * So the guided-handover gate is enforced in deliverQuote, against the database,
 * for every caller — every id must be a COMPLETED run of THIS quote's handover
 * in the acting tenant, and a tenant with an ACTIVE quote.delivery template must
 * have one per template. A tenant with no active template is the legacy flow,
 * unchanged.
 *
 * The paperwork below (delivery note, customer signature) is stored by the
 * `collectEvidence` callback, which deliverQuote runs only AFTER every gate — a
 * refused delivery leaves no blob or Document row behind — and whose result is
 * written in the SAME update that records the delivery.
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

    // Read-only checks before handing over, so an oversized file is refused
    // before any gate or write.
    const file = pickFile(formData);
    if (file && file.size > MAX_FILE) refuse("That delivery note is larger than 4 MB.");

    return deliverQuote({
      quoteId,
      tenantId,
      user,
      handoverRunIds,
      collectEvidence: async (quote): Promise<DeliveryEvidence> => {
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
        return { deliveredByName, deliveryChecklist, deliverySignatureRef };
      },
    });
  });
}
