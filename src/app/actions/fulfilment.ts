"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireQuoteAccess } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { runLeadAutomations } from "@/lib/automations";
import { saveFile } from "@/lib/storage";
import { contactName } from "@/lib/format";
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
  // The whole fulfilment pipeline (invoice → deposit → schedule → deliver) is
  // automotive-owned and drives the automotive /deliveries board. Every stage is
  // reachable by direct POST, so gate each one server-side; throws when off.
  await requireModuleEnabled("automotive");
  const user = await requireQuoteAccess(quoteId, "deliveries.manage");
  const quote = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId }, include: { contact: true } });
  if (quote.status !== "accepted" || quote.invoicedAt) return;
  const file = pickFile(formData);
  if (!file || file.size > MAX_FILE) return;
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
}

export async function markDepositPaid(quoteId: string, formData: FormData) {
  await requireModuleEnabled("automotive");
  const user = await requireQuoteAccess(quoteId, "deliveries.manage");
  const quote = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId } });
  if (!quote.invoicedAt || quote.depositPaidAt) return;
  const file = pickFile(formData);
  if (!file || file.size > MAX_FILE) return;
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
}

export async function scheduleDelivery(quoteId: string, formData: FormData) {
  // Scheduling a delivery is automotive-owned fulfilment (workshop activity +
  // delivery paperwork). Reachable by direct POST regardless of the UI, so gate
  // it server-side; throws when the automotive pack is off.
  await requireModuleEnabled("automotive");
  const user = await requireQuoteAccess(quoteId, "deliveries.manage");
  const quote = await prisma.quote.findUniqueOrThrow({
    where: { id: quoteId },
    include: { contact: true, lead: { include: { product: true } }, items: true },
  });
  if (!quote.depositPaidAt || quote.deliveryScheduledFor) return;
  const dateRaw = String(formData.get("date") ?? "").trim();
  if (!dateRaw) return;
  const when = new Date(dateRaw);
  if (isNaN(when.getTime())) return;
  const file = pickFile(formData);
  if (file && file.size <= MAX_FILE) {
    await attachStageDocument(quoteId, quote.contactId, "delivery-note", `Delivery paperwork — Q-${quote.number} — ${file.name}`, file, user.id);
  }
  const model = quote.lead?.product?.name ?? quote.items[0]?.description ?? "cart";
  const who = quote.contact ? contactName(quote.contact) : quote.lead?.name ?? "";
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
}

export async function uploadDeliveryPhotos(quoteId: string, formData: FormData) {
  // Delivery photos are automotive-owned paperwork; reject when the pack is off
  // (matches this file's early-return failure convention). Belt-and-braces with
  // the automotive-gated UI on the quote page — the action is reachable by a
  // direct POST regardless of what is rendered.
  if (!(await isModuleEnabled("automotive"))) return;
  const user = await requireQuoteAccess(quoteId, "deliveries.manage");
  const quote = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId } });
  const files = formData.getAll("files").filter(
    (file): file is File => typeof file === "object" && (file as File).size > 0
  );
  let saved = 0;
  for (const file of files.slice(0, 10)) {
    if (file.size > MAX_FILE || !file.type.startsWith("image/")) continue;
    await attachStageDocument(quoteId, quote.contactId, "delivery-photo", `Delivery photo — Q-${quote.number} — ${file.name}`, file, user.id);
    saved++;
  }
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
}

export async function markDelivered(quoteId: string, formData: FormData) {
  // Marking delivered files delivery notes/signatures and redirects into vehicle
  // registration — all automotive-owned. Gate server-side (throws when off) so a
  // direct POST can't drive automotive fulfilment with the pack disabled.
  await requireModuleEnabled("automotive");
  const user = await requireQuoteAccess(quoteId, "deliveries.manage");
  const quote = await prisma.quote.findUniqueOrThrow({
    where: { id: quoteId },
    include: { lead: true },
  });
  if (!quote.deliveryScheduledFor || quote.deliveredAt) return;
  const file = pickFile(formData);
  if (file && file.size <= MAX_FILE) {
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
  if (quote.leadId) await runLeadAutomations("delivered", quote.leadId).catch(() => {});
  await logAudit({
    action: "fulfilment.delivered",
    summary: `Q-${quote.number} delivered 🎉 — register the vehicle to start its service life`,
    contactId: quote.contactId,
    leadId: quote.leadId,
    user,
  });
  revalidatePath("/deliveries");
  revalidatePath(`/quotes/${quoteId}`);
  redirect(`/vehicles/new?contactId=${quote.contactId ?? ""}&productId=${quote.lead?.productId ?? ""}&color=${encodeURIComponent(quote.lead?.color ?? "")}`);
}
