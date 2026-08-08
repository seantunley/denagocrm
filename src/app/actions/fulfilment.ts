"use server";

import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireQuoteAccess } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { emitLeadJourneyEvent } from "@/lib/leadJourneyEvents";
import { saveFile } from "@/lib/storage";
import { checkUploadPayload } from "@/lib/photoBudget";
import { contactName } from "@/lib/format";
import { loadBillToFleet, quoteBillTo } from "@/lib/quoteBillTo";
import { isModuleEnabled, requireModuleEnabled } from "@/lib/modules/enabled";

const MAX_FILE = 4 * 1024 * 1024;

async function attachStageDocument(
  quoteId: string,
  contactId: string | null,
  tag: string,
  fileName: string,
  file: File,
  userId: string
) {
  const buffer = Buffer.from(await file.arrayBuffer());
  const storedName = await saveFile(buffer, file.name || fileName, file.type || "application/pdf");
  await prisma.document.create({
    data: {
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
    // The whole fulfilment pipeline (invoice → deposit → schedule → deliver) is
    // automotive-owned and drives the automotive /deliveries board. Every stage is
    // reachable by direct POST, so gate each one server-side; throws when off.
    await requireModuleEnabled("automotive");
    const user = await requireQuoteAccess(quoteId, "deliveries.manage");
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId }, include: { contact: true } });
    if (quote.status !== "accepted") refuse("Only an accepted quote can be invoiced.");
    if (quote.invoicedAt) refuse("This quote has already been invoiced.");
    const file = pickFile(formData);
    // Silently dropping an oversized upload and reporting success is the worst
    // of these: the paperwork simply never arrives and nobody is told.
    if (!file) refuse("Choose a file to upload.");
    if (file.size > MAX_FILE) refuse("That file is larger than 4 MB.");
    await attachStageDocument(quoteId, quote.contactId, "invoice", `Invoice — Q-${quote.number}${file.name ? ` — ${file.name}` : ".pdf"}`, file, user.id);
    await prisma.quote.update({ where: { id: quoteId }, data: { invoicedAt: new Date() } });
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
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId } });
    if (!quote.invoicedAt) refuse("Invoice this quote before recording a deposit.");
    if (quote.depositPaidAt) refuse("The deposit is already recorded.");
    const file = pickFile(formData);
    // Silently dropping an oversized upload and reporting success is the worst
    // of these: the paperwork simply never arrives and nobody is told.
    if (!file) refuse("Choose a file to upload.");
    if (file.size > MAX_FILE) refuse("That file is larger than 4 MB.");
    await attachStageDocument(quoteId, quote.contactId, "pop", `Proof of payment — Q-${quote.number}${file.name ? ` — ${file.name}` : ".pdf"}`, file, user.id);
    await prisma.quote.update({ where: { id: quoteId }, data: { depositPaidAt: new Date() } });
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
    // Scheduling a delivery is automotive-owned fulfilment (workshop activity +
    // delivery paperwork). Reachable by direct POST regardless of the UI, so gate
    // it server-side; throws when the automotive pack is off.
    await requireModuleEnabled("automotive");
    const user = await requireQuoteAccess(quoteId, "deliveries.manage");
    const quote = await prisma.quote.findUniqueOrThrow({
      where: { id: quoteId },
      include: { contact: true, lead: { include: { product: true } }, items: true },
    });
    if (!quote.depositPaidAt) refuse("Record the deposit before scheduling delivery.");
    if (quote.deliveryScheduledFor) refuse("Delivery is already scheduled.");
    const dateRaw = String(formData.get("date") ?? "").trim();
    if (!dateRaw) refuse("Choose a delivery date.");
    const when = new Date(dateRaw);
    if (isNaN(when.getTime())) refuse("That delivery date is not valid.");
    const file = pickFile(formData);
    // The file is optional, but a SELECTED one that is too large must not be
    // dropped while the stage change proceeds: the user picked it, the toast says
    // it worked, and the form is gone. Refuse before anything is committed.
    if (file && file.size > MAX_FILE) refuse("That delivery paperwork is larger than 4 MB.");
    if (file) {
      await attachStageDocument(quoteId, quote.contactId, "delivery-note", `Delivery paperwork — Q-${quote.number} — ${file.name}`, file, user.id);
    }
    const model = quote.lead?.product?.name ?? quote.items[0]?.description ?? "cart";
    // The scheduling task says who the cart is going to; for a fleet order that
    // is the account, which is what the driver's paperwork will also say.
    const who = quoteBillTo(quote, await loadBillToFleet(prisma, quote.fleetId)).name;
    await prisma.quote.update({ where: { id: quoteId }, data: { deliveryScheduledFor: when } });
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
    // Authorise the caller BEFORE any refusal, so the rule holds everywhere
    // without exceptions to reason about. This particular one leaks nothing about
    // the quote — the automotive pack being off is install-wide config — but
    // "except where the message is harmless" is precisely the judgement that goes
    // wrong later, and it costs nothing to order it correctly.
    const user = await requireQuoteAccess(quoteId, "deliveries.manage");
    // Delivery photos are automotive-owned paperwork; reject when the pack is off.
    // Belt-and-braces with the automotive-gated UI on the quote page — the action
    // is reachable by a direct POST regardless of what is rendered.
    if (!(await isModuleEnabled("automotive"))) refuse("The automotive pack is switched off.");
    const quote = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId } });
    const files = formData.getAll("files").filter(
      (file): file is File => typeof file === "object" && (file as File).size > 0
    );
    // The input is not `required`, so "Add delivery photos" with nothing selected
    // used to report "Photos uploaded" having saved nothing at all.
    if (files.length === 0) refuse("Choose at least one photo.");

    const MAX_PHOTOS = 10;
    const accepted = files.filter((file) => file.size <= MAX_FILE && file.type.startsWith("image/"));
    if (accepted.length === 0) {
      refuse("None of those files could be used — photos must be images under 4 MB.");
    }
    // The TOTAL, not just each file. Ten files individually under 4 MB is 40 MB,
    // which the framework refuses before this function runs — so the per-file limit
    // was the only one enforced and the real ceiling was invisible. Same budget the
    // client resizes against.
    const payload = checkUploadPayload(accepted.slice(0, MAX_PHOTOS).map((file) => file.size), {
      maxPhotos: MAX_PHOTOS,
      maxPerFile: MAX_FILE,
    });
    if (!payload.ok) refuse(payload.reason);

    let saved = 0;
    for (const file of accepted.slice(0, MAX_PHOTOS)) {
      await attachStageDocument(quoteId, quote.contactId, "delivery-photo", `Delivery photo — Q-${quote.number} — ${file.name}`, file, user.id);
      saved++;
    }
    // Say what actually happened when some were dropped: "Photos uploaded" after
    // silently discarding six of sixteen is the same lie as reporting a save that
    // never ran, just quieter.
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
    // Marking delivered files delivery notes/signatures and redirects into vehicle
    // registration — all automotive-owned. Gate server-side (throws when off) so a
    // direct POST can't drive automotive fulfilment with the pack disabled.
    await requireModuleEnabled("automotive");
    const user = await requireQuoteAccess(quoteId, "deliveries.manage");
    const quote = await prisma.quote.findUniqueOrThrow({
      where: { id: quoteId },
      include: { lead: true },
    });
    if (!quote.deliveryScheduledFor) refuse("Schedule the delivery before marking it delivered.");
    if (quote.deliveredAt) refuse("This delivery is already marked as delivered.");
    const file = pickFile(formData);
    // The file is optional, but a SELECTED one that is too large must not be
    // dropped while the stage change proceeds: the user picked it, the toast says
    // it worked, and the form is gone. Refuse before anything is committed.
    if (file && file.size > MAX_FILE) refuse("That delivery note is larger than 4 MB.");
    if (file) {
      await attachStageDocument(quoteId, quote.contactId, "delivery-note", `Delivery note — Q-${quote.number} — ${file.name}`, file, user.id);
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
        deliverySignatureRef = await saveFile(buffer, `delivery-signature-Q${quote.number}.png`, "image/png");
        await prisma.document.create({
          data: {
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

    await prisma.quote.update({
      where: { id: quoteId },
      data: { deliveredAt: new Date(), deliveredByName, deliveryChecklist, deliverySignatureRef },
    });
    // Keyed on the quote — delivery writes `Quote.deliveredAt`, not the lead —
    // and `deliveredAt` is set once, so the quote id alone is the occurrence.
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
