"use server";

import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { actingTenantId } from "@/lib/actingTenant";
import { customerRecordTenantId } from "@/lib/customerRecordTenant";
import { requireQuoteAccess } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { emitLeadJourneyEvent } from "@/lib/leadJourneyEvents";
import { saveFile } from "@/lib/storage";
import { checkUploadPayload } from "@/lib/photoBudget";
import { contactName } from "@/lib/format";
import { loadBillToFleet, quoteBillTo } from "@/lib/quoteBillTo";
import { isModuleEnabled, requireModuleEnabled } from "@/lib/modules/enabled";

const MAX_FILE = 4 * 1024 * 1024;
const QUOTE_GONE = "This quote is no longer available in this workspace.";

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
}

function pickFile(formData: FormData): File | null {
  const file = formData.get("file");
  return file && typeof file === "object" && (file as File).size > 0 ? (file as File) : null;
}

export async function markInvoiced(quoteId: string, formData: FormData) {
  return asActionResult(async () => {
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
  return asActionResult(async () => {
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
  return asActionResult(async () => {
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

export async function uploadDeliveryPhotos(quoteId: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireQuoteAccess(quoteId, "deliveries.manage");
    if (!(await isModuleEnabled("automotive"))) refuse("The automotive pack is switched off.");
    const tenantId = await actingTenantId();
    const quote = await prisma.quote.findFirst({ where: { id: quoteId, tenantId } });
    if (!quote) refuse(QUOTE_GONE);
    const files = formData.getAll("files").filter(
      (file): file is File => typeof file === "object" && (file as File).size > 0
    );
    if (files.length === 0) refuse("Choose at least one photo.");

    const MAX_PHOTOS = 10;
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
    for (const file of accepted.slice(0, MAX_PHOTOS)) {
      await attachStageDocument(quoteId, quote.contactId, "delivery-photo", `Delivery photo — Q-${quote.number} — ${file.name}`, file, user.id, quote.tenantId);
      saved++;
    }
    const rejected = files.length - accepted.length;
    const overCap = Math.max(0, accepted.length - MAX_PHOTOS);
    const skipped = rejected + overCap;
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
  });
}

export async function markDelivered(quoteId: string, formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    await requireModuleEnabled("automotive");
    const user = await requireQuoteAccess(quoteId, "deliveries.manage");
    const tenantId = await actingTenantId();
    const quote = await prisma.quote.findFirst({
      where: { id: quoteId, tenantId },
      include: { lead: true },
    });
    if (!quote) refuse(QUOTE_GONE);
    if (!quote.deliveryScheduledFor) refuse("Schedule the delivery before marking it delivered.");
    if (quote.deliveredAt) refuse("This delivery is already marked as delivered.");
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
      data: { deliveredAt: new Date(), deliveredByName, deliveryChecklist, deliverySignatureRef },
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
    return { redirectTo: `/vehicles/new?contactId=${quote.contactId ?? ""}&productId=${quote.lead?.productId ?? ""}&color=${encodeURIComponent(quote.lead?.color ?? "")}` };
  });
}
