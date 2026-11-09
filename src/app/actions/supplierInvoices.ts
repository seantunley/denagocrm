"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { requireDocumentAccess } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { readSupplierInvoice } from "@/lib/supplierInvoiceReader";
import { invoiceCents, invoiceDay, isSupplierInvoice } from "@/lib/supplierInvoiceRules";

/** The supplier invoice document, in its own workspace, for someone who may open it and upload documents. */
async function invoiceDocument(documentId: string) {
  const user = await requireDocumentAccess(documentId, "documents.upload");
  const doc = await prisma.document.findFirst({ where: { id: documentId, deletedAt: null }, select: { id: true, tenantId: true, tag: true, fileName: true } });
  if (!doc || !doc.tenantId) refuse("That document is no longer there — refresh the page.");
  if (!isSupplierInvoice(doc.tag)) refuse("Only a document filed as a supplier invoice is read.");
  return { user, doc: { ...doc, tenantId: doc.tenantId } };
}

/** "Read invoice" — for an older invoice, or one that couldn't be read the first time. */
export async function readSupplierInvoiceNow(documentId: string, revalidate: string): Promise<ActionResult> {
  return asActionResult(async () => {
    const { doc } = await invoiceDocument(documentId);
    const outcome = await readSupplierInvoice(doc.id, doc.tenantId);
    revalidatePath(revalidate);
    if (outcome === "read") return { success: "Read — check it and confirm" };
    if (outcome === "confirmed-already") return { success: "Already confirmed" };
    if (outcome === "not-configured") refuse("AI isn't set up for this workspace (Settings → Integrations), or Suppliers is off.");
    refuse("Nothing could be read from it — fill it in yourself below.");
  });
}

/**
 * A person confirms what the invoice says — as read, or corrected. From here on the reader never overwrites it.
 * Blank fields stay blank: nothing is invented to make a row look complete.
 */
export async function confirmSupplierInvoice(documentId: string, revalidate: string, formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const { user, doc } = await invoiceDocument(documentId);
    const number = String(formData.get("invoiceNumber") ?? "").trim().slice(0, 60) || null;
    const rawTotal = String(formData.get("total") ?? "").trim();
    const totalCents = rawTotal ? invoiceCents(rawTotal) : null;
    if (rawTotal && totalCents === null) refuse("That total isn't an amount — e.g. 12500.00");
    const date = (name: string) => {
      const raw = String(formData.get(name) ?? "").trim();
      if (!raw) return null;
      const day = invoiceDay(raw);
      if (!day) refuse("Use the date picker for the dates.");
      return day;
    };
    const currency = String(formData.get("currency") ?? "").trim().toUpperCase();
    const data = {
      invoiceNumber: number,
      invoiceDate: date("invoiceDate"),
      dueDate: date("dueDate"),
      totalCents,
      currency: /^[A-Z]{3}$/.test(currency) ? currency : null,
      status: "confirmed",
      confirmedAt: new Date(),
      confirmedById: user.id,
    };
    const updated = await prisma.supplierInvoice.updateMany({ where: { documentId: doc.id, tenantId: doc.tenantId }, data });
    if (updated.count === 0) await prisma.supplierInvoice.create({ data: { tenantId: doc.tenantId, documentId: doc.id, ...data } });
    await logAudit({ action: "supplier_invoice.confirmed", summary: `Confirmed supplier invoice “${doc.fileName}”${number ? ` (${number})` : ""}`, user });
    revalidatePath(revalidate);
    return { success: "Invoice confirmed" };
  });
}
