"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireTenantOwner } from "@/lib/auth";
import { actingTenantId } from "@/lib/actingTenant";
import { logAudit } from "@/lib/audit";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { requireQuoteAccess } from "@/lib/permissions";
import { normaliseVendorName, vendorKind } from "@/lib/vendors";
import { dealKey, linkVendorToDeal } from "@/lib/dealVendors";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { Prisma } from "@prisma/client";
import { getSetting } from "@/lib/settings";
import { DOCUMENT_TYPES_KEY, parseDocumentTypes } from "@/lib/documentLabels";
import { tickedTypes } from "@/lib/dealFile";

/** Settings → Suppliers: the businesses deals and purchase orders name. Owner only; every change audited. */

const PAGE = "/settings/vendors";

/** Every action here belongs to the Suppliers module: refused, with a reason, when the workspace hasn't got it. */
async function requireSuppliers() {
  if (!(await isModuleEnabled("suppliers"))) refuse("Suppliers aren't switched on for this workspace.");
}
const field = (formData: FormData, key: string, max: number) => String(formData.get(key) ?? "").trim().slice(0, max) || null;

export async function saveVendor(id: string | null, formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    await requireSuppliers();
    const tenantId = await actingTenantId();
    const name = field(formData, "name", 120);
    if (!name) refuse("Give the supplier a name.");
    const data = {
      name,
      kind: vendorKind(formData.get("kind")),
      vatNumber: field(formData, "vatNumber", 40),
      registrationNumber: field(formData, "registrationNumber", 40),
      address: field(formData, "address", 400),
      paymentTerms: field(formData, "paymentTerms", 120),
      paymentReference: field(formData, "paymentReference", 80),
      phone: field(formData, "phone", 40),
      email: field(formData, "email", 160),
      notes: field(formData, "notes", 1000),
    };
    // A workspace has a handful of suppliers: compared here, ignoring case, punctuation and "(Pty) Ltd",
    // so "Wrap Studio" and "Wrap Studio (Pty) Ltd" can't both be added.
    const others = await prisma.vendor.findMany({ where: { tenantId, deletedAt: null, ...(id ? { NOT: { id } } : {}) }, select: { name: true } });
    const same = others.find((other) => normaliseVendorName(other.name) === normaliseVendorName(name));
    if (same) refuse(`“${same.name}” is already on the list — that's the same supplier.`);
    if (id) {
      const changed = await prisma.vendor.updateMany({ where: { id, tenantId, deletedAt: null }, data });
      if (changed.count !== 1) refuse("That supplier is no longer there — refresh the page.");
    } else {
      await prisma.vendor.create({ data: { tenantId, ...data } });
    }
    await logAudit({ action: id ? "vendor.updated" : "vendor.created", summary: `${id ? "Updated" : "Added"} supplier “${name}”`, user });
    revalidatePath(PAGE);
    if (id) revalidatePath(`${PAGE}/${id}`);
    return { success: id ? "Supplier saved" : "Supplier added" };
  });
}

/**
 * What the deal file asks of THIS supplier (Sean, 2026-11-10: "different documents per supplier"): the workspace's
 * default supplier list, or its own — chosen from the Document types, and possibly none at all.
 */
export async function saveVendorRequiredDocuments(id: string, formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    await requireSuppliers();
    const tenantId = await actingTenantId();
    const own = formData.get("mode") === "own";
    const list = own ? tickedTypes(formData.getAll("type"), parseDocumentTypes(await getSetting(DOCUMENT_TYPES_KEY))) : null;
    const vendor = await prisma.vendor.findFirst({ where: { id, tenantId, deletedAt: null }, select: { name: true } });
    if (!vendor) refuse("That supplier is no longer there — refresh the page.");
    const changed = await prisma.vendor.updateMany({
      where: { id, tenantId, deletedAt: null },
      data: { requiredDocuments: list === null ? Prisma.DbNull : list },
    });
    if (changed.count !== 1) refuse("That supplier is no longer there — refresh the page.");
    await logAudit({
      action: "vendor.required_documents",
      summary: list === null
        ? `Deal file: “${vendor.name}” uses the default supplier list`
        : `Deal file: “${vendor.name}” is asked for ${list.join(", ") || "nothing"}`,
      user,
    });
    revalidatePath(`${PAGE}/${id}`);
    return { success: "Saved" };
  });
}

/** To the Trash (restorable). Its documents, orders and deals keep naming it. */
export async function deleteVendor(id: string, formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    await requireSuppliers();
    const tenantId = await actingTenantId();
    const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
    const vendor = await prisma.vendor.findFirst({ where: { id, tenantId, deletedAt: null }, select: { name: true } });
    if (!vendor) refuse("That supplier is already gone — refresh the page.");
    await prisma.vendor.updateMany({ where: { id, tenantId, deletedAt: null }, data: { deletedAt: new Date() } });
    await logAudit({ action: "trash.deleted", summary: `Moved supplier “${vendor.name}” to trash — ${reason}`, user });
    revalidatePath(PAGE);
    return { success: "Moved to trash", redirectTo: PAGE };
  });
}

/** The quote a deal-page change is made from, in the acting workspace, with its deal. Access checked first. */
async function dealQuote(quoteId: string) {
  const user = await requireQuoteAccess(quoteId, "documents.upload");
  await requireSuppliers();
  const tenantId = await actingTenantId();
  const quote = await prisma.quote.findFirst({ where: { id: quoteId, tenantId, deletedAt: null }, select: { id: true, number: true, leadId: true, contactId: true } });
  if (!quote) refuse("That quote is no longer there — refresh the page.");
  return { user, tenantId, quote };
}

/**
 * Say a supplier is on this deal, so its file asks for that supplier's quote, invoice and proof of payment before
 * any of them arrive. Anyone who may upload to the deal. Uploading a supplier document adds it as well.
 */
export async function addDealVendor(quoteId: string, formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const { user, tenantId, quote } = await dealQuote(quoteId);
    const vendor = await prisma.vendor.findFirst({ where: { id: String(formData.get("vendorId") ?? ""), tenantId, deletedAt: null }, select: { id: true, name: true } });
    if (!vendor) refuse("Choose a supplier from the list.");
    const added = await linkVendorToDeal({ tenantId, quote, vendorId: vendor.id, userId: user.id });
    if (!added) refuse(`${vendor.name} is already on this deal.`);
    await logAudit({
      action: "deal.supplier_added",
      summary: `Added supplier “${vendor.name}” to the deal on Q-${quote.number}`,
      ...(quote.contactId ? { contactId: quote.contactId } : {}),
      ...(quote.leadId ? { leadId: quote.leadId } : {}),
      user,
    });
    revalidatePath(`/deals/${quoteId}`);
    return { success: `${vendor.name} added` };
  });
}

/** Take a supplier off this deal. Its documents stay filed — and a supplier named on one still counts. */
export async function removeDealVendor(quoteId: string, vendorId: string): Promise<ActionResult> {
  return asActionResult(async () => {
    const { user, tenantId, quote } = await dealQuote(quoteId);
    const link = await prisma.dealVendor.findFirst({ where: { tenantId, vendorId, ...dealKey(quote) }, select: { id: true, vendor: { select: { name: true } } } });
    if (!link) refuse("That supplier is no longer on this deal — refresh the page.");
    await prisma.dealVendor.deleteMany({ where: { id: link.id, tenantId } });
    await logAudit({
      action: "deal.supplier_removed",
      summary: `Took supplier “${link.vendor.name}” off the deal on Q-${quote.number}`,
      ...(quote.contactId ? { contactId: quote.contactId } : {}),
      ...(quote.leadId ? { leadId: quote.leadId } : {}),
      user,
    });
    revalidatePath(`/deals/${quoteId}`);
    return { success: "Removed" };
  });
}
