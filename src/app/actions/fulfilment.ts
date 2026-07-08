"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireCrm } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { runLeadAutomations } from "@/lib/automations";
import { saveFile } from "@/lib/storage";
import { contactName } from "@/lib/format";

const MAX_FILE = 4 * 1024 * 1024; // server-action body limit headroom

async function attachStageDocument(
  quoteId: string,
  contactId: string | null,
  tag: string,
  fileName: string,
  file: File,
  userId: string
) {
  const buf = Buffer.from(await file.arrayBuffer());
  const storedName = await saveFile(buf, file.name || fileName, file.type || "application/pdf");
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
  const f = formData.get("file");
  return f && typeof f === "object" && (f as File).size > 0 ? (f as File) : null;
}

/** Invoiced — the invoice document is mandatory. */
export async function markInvoiced(quoteId: string, formData: FormData) {
  const user = await requireCrm();
  const quote = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId }, include: { contact: true } });
  if (quote.status !== "accepted" || quote.invoicedAt) return;
  const file = pickFile(formData);
  if (!file || file.size > MAX_FILE) return;
  await attachStageDocument(
    quoteId,
    quote.contactId,
    "invoice",
    `Invoice — Q-${quote.number}${file.name ? ` — ${file.name}` : ".pdf"}`,
    file,
    user.id
  );
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

/** Deposit paid — proof of payment is mandatory. */
export async function markDepositPaid(quoteId: string, formData: FormData) {
  const user = await requireCrm();
  const quote = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId } });
  if (!quote.invoicedAt || quote.depositPaidAt) return;
  const file = pickFile(formData);
  if (!file || file.size > MAX_FILE) return;
  await attachStageDocument(
    quoteId,
    quote.contactId,
    "pop",
    `Proof of payment — Q-${quote.number}${file.name ? ` — ${file.name}` : ".pdf"}`,
    file,
    user.id
  );
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

/** Delivery scheduled — date required, document optional; lands on the workshop calendar. */
export async function scheduleDelivery(quoteId: string, formData: FormData) {
  const user = await requireCrm();
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
    await attachStageDocument(
      quoteId,
      quote.contactId,
      "delivery-note",
      `Delivery paperwork — Q-${quote.number} — ${file.name}`,
      file,
      user.id
    );
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

/** Delivery photos — multiple, any time from scheduling onwards. */
export async function uploadDeliveryPhotos(quoteId: string, formData: FormData) {
  const user = await requireCrm();
  const quote = await prisma.quote.findUniqueOrThrow({ where: { id: quoteId } });
  const files = formData.getAll("files").filter(
    (f): f is File => typeof f === "object" && (f as File).size > 0
  );
  let saved = 0;
  for (const file of files.slice(0, 10)) {
    if (file.size > MAX_FILE || !file.type.startsWith("image/")) continue;
    await attachStageDocument(
      quoteId,
      quote.contactId,
      "delivery-photo",
      `Delivery photo — Q-${quote.number} — ${file.name}`,
      file,
      user.id
    );
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

/** Delivered — proof of delivery (driver, checklist, signature), then vehicle registration. */
export async function markDelivered(quoteId: string, formData: FormData) {
  const user = await requireCrm();
  const quote = await prisma.quote.findUniqueOrThrow({
    where: { id: quoteId },
    include: { lead: true },
  });
  if (!quote.deliveryScheduledFor || quote.deliveredAt) return;
  const file = pickFile(formData);
  if (file && file.size <= MAX_FILE) {
    await attachStageDocument(
      quoteId,
      quote.contactId,
      "delivery-note",
      `Delivery note — Q-${quote.number} — ${file.name}`,
      file,
      user.id
    );
  }

  // Proof of delivery: driver, handover checklist, captured signature
  const deliveredByName = String(formData.get("deliveredByName") ?? "").trim() || null;
  let deliveryChecklist: object | undefined;
  try {
    const parsed = JSON.parse(String(formData.get("checklist") ?? ""));
    if (parsed && typeof parsed === "object") deliveryChecklist = parsed;
  } catch {
    /* no checklist submitted */
  }
  let deliverySignatureRef: string | null = null;
  const sig = String(formData.get("signature") ?? "");
  if (sig.startsWith("data:image/png;base64,")) {
    const buf = Buffer.from(sig.split(",")[1], "base64");
    if (buf.length > 0 && buf.length <= MAX_FILE) {
      deliverySignatureRef = await saveFile(buf, `delivery-signature-Q${quote.number}.png`, "image/png");
      await prisma.document.create({
        data: {
          fileName: `Delivery signature — Q-${quote.number}`,
          storedName: deliverySignatureRef,
          mimeType: "image/png",
          sizeBytes: buf.length,
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
    data: {
      deliveredAt: new Date(),
      deliveredByName,
      deliveryChecklist,
      deliverySignatureRef,
    },
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
  // Straight into vehicle registration, prefilled — which offers the review request
  redirect(
    `/vehicles/new?contactId=${quote.contactId ?? ""}&productId=${quote.lead?.productId ?? ""}&color=${encodeURIComponent(quote.lead?.color ?? "")}`
  );
}
