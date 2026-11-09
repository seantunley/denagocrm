"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { actingTenantId } from "@/lib/actingTenant";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { logAudit } from "@/lib/audit";
import { requireAnyPermission, requirePermission, requireQuoteAccess } from "@/lib/permissions";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { sendEmail } from "@/lib/email";
import { brandForTenant, DEFAULT_BRAND } from "@/lib/tenantBrand";
import { waMeLink } from "@/lib/captureTarget";
import { isLineIncluded } from "@/lib/pricing";
import { linkVendorToDeal } from "@/lib/dealVendors";
import { bookingDay, bookingMessage, canMoveDelivery, deliveryStatusLabel } from "@/lib/vendorDeliveryRules";

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const text = (formData: FormData, name: string, max: number) => String(formData.get(name) ?? "").trim().slice(0, max);

export type BookingTarget = { quoteId: string } | { purchaseOrderId: string };
type BookingResult = ActionResult & { message?: string; whatsapp?: string | null };

/**
 * Book a delivery with a transport supplier (vendors plan step 2): to the customer on an accepted quote, or into
 * the warehouse on an open purchase order. The booking goes to the supplier on THIS click only — emailed from the
 * workspace, or handed back here as text to paste into WhatsApp — and is kept on the deal and in the audit trail.
 * A customer delivery also adds the supplier to the deal, so its quote, invoice and proof of payment are expected.
 */
export async function bookVendorDelivery(target: BookingTarget, formData: FormData): Promise<BookingResult> {
  return asActionResult(async () => {
    const outbound = "quoteId" in target;
    const user = outbound ? await requireQuoteAccess(target.quoteId, "deliveries.manage") : await requirePermission("stock.manage");
    if (!(await isModuleEnabled("suppliers"))) refuse("Suppliers aren't switched on for this workspace.");
    const tenantId = await actingTenantId();

    let reference: string;
    let items: string[];
    let deal: { id: string; leadId: string | null; contactId: string | null } | null = null;
    if (outbound) {
      const quote = await prisma.quote.findFirst({
        where: { id: target.quoteId, tenantId, deletedAt: null, supersededAt: null, status: "accepted" },
        select: { id: true, number: true, leadId: true, contactId: true, deliveredAt: true, items: { orderBy: { sortOrder: "asc" }, select: { description: true, qty: true, unitPriceCents: true, optional: true, selected: true } } },
      });
      if (!quote) refuse("Only an accepted quote's delivery can be booked — refresh the page.");
      if (quote.deliveredAt) refuse("This one has already been delivered.");
      reference = `Q-${quote.number}`;
      items = quote.items.filter(isLineIncluded).map((item) => `${item.qty} × ${item.description}`);
      deal = quote;
    } else {
      const order = await prisma.purchaseOrder.findFirst({
        where: { id: target.purchaseOrderId, tenantId, deletedAt: null, status: { in: ["ordered", "partially_received"] } },
        select: { reference: true, supplier: true, lines: { select: { orderedQty: true, color: true, product: { select: { name: true } } } } },
      });
      if (!order) refuse("Only an open purchase order's delivery can be booked — refresh the page.");
      reference = order.reference ? `order ${order.reference}` : `${order.supplier} order`;
      items = order.lines.map((line) => `${line.orderedQty} × ${line.product.name}${line.color ? ` (${line.color})` : ""}`);
    }

    const vendor = await prisma.vendor.findFirst({
      where: { id: String(formData.get("vendorId") ?? ""), tenantId, deletedAt: null },
      select: { id: true, name: true, email: true, phone: true },
    });
    if (!vendor) refuse("Choose the delivery company from the list.");
    const day = bookingDay(formData.get("date"));
    if (!day) refuse("Choose the delivery date.");
    if (day.getTime() < Date.now() - 2 * 86_400_000) refuse("That date has passed — choose the day it will happen.");
    const fromAddress = text(formData, "from", 300);
    const toAddress = text(formData, "to", 300);
    if (!fromAddress || !toAddress) refuse("Say where it is collected from and where it goes.");
    const note = text(formData, "note", 1000) || null;
    const send = formData.get("send") === "copy" ? "copy" : "email";
    const email = text(formData, "email", 200) || vendor.email || "";
    if (send === "email" && !EMAIL.test(email)) refuse(`Give ${vendor.name}'s email address — or copy the booking and send it yourself.`);

    const brand = (await brandForTenant(tenantId).catch(() => DEFAULT_BRAND)).displayName;
    const dayLabel = day.toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
    const message = bookingMessage({ brand, vendorName: vendor.name, reference, dayLabel, fromAddress, toAddress, items, note });

    const booking = await prisma.vendorDelivery.create({
      data: {
        tenantId, vendorId: vendor.id,
        ...(outbound ? { quoteId: target.quoteId } : { purchaseOrderId: target.purchaseOrderId }),
        scheduledFor: day, fromAddress, toAddress, note,
        sentTo: send === "email" ? email : "copied", createdById: user.id,
      },
      select: { id: true },
    });
    if (send === "email") {
      const sent = await sendEmail({ to: email, subject: message.subject, text: message.text, senderName: user.name });
      if (!sent.ok) {
        // Nothing went: no booking is left saying it did.
        await prisma.vendorDelivery.deleteMany({ where: { id: booking.id, tenantId } });
        refuse(`The email didn't go: ${sent.error ?? "the mail server refused it"}. Nothing was booked.`);
      }
    }
    if (deal) await linkVendorToDeal({ tenantId, quote: deal, vendorId: vendor.id, userId: user.id });

    await logAudit({
      action: "delivery.booked",
      summary: `Booked ${vendor.name} for ${reference} on ${dayLabel}${send === "email" ? ` — emailed to ${email}` : " — copied to send by hand"}`,
      ...(deal?.leadId ? { leadId: deal.leadId } : {}),
      ...(deal?.contactId ? { contactId: deal.contactId } : {}),
      user,
      entityType: "VendorDelivery",
      entityId: booking.id,
    });
    revalidatePath(outbound ? "/deliveries" : "/stock");
    if (outbound) revalidatePath(`/deals/${target.quoteId}`);
    return send === "email"
      ? { success: `Booking emailed to ${vendor.name}` }
      : { success: "Booked — copy the message and send it", message: message.text, whatsapp: waMeLink(vendor.phone) };
  });
}

/** Move a booking along as the supplier reports back: confirmed, collected, delivered — or cancelled before collection. */
export async function setVendorDeliveryStatus(bookingId: string, status: string): Promise<ActionResult> {
  return asActionResult(async () => {
    // Anyone who may book either kind, first; then the one this booking needs, below.
    await requireAnyPermission("deliveries.manage", "stock.manage");
    const tenantId = await actingTenantId();
    const booking = await prisma.vendorDelivery.findFirst({
      where: { id: bookingId, tenantId },
      select: { id: true, status: true, quoteId: true, vendor: { select: { name: true } } },
    });
    if (!booking) refuse("That booking is no longer there — refresh the page.");
    const user = booking.quoteId ? await requireQuoteAccess(booking.quoteId, "deliveries.manage") : await requirePermission("stock.manage");
    if (!canMoveDelivery(booking.status, status)) refuse(`A ${deliveryStatusLabel(booking.status).toLowerCase()} booking can't become ${deliveryStatusLabel(status).toLowerCase()}.`);
    // Only from the status it was read in: two people pressing at once can't skip a step.
    const moved = await prisma.vendorDelivery.updateMany({ where: { id: booking.id, tenantId, status: booking.status }, data: { status, statusAt: new Date() } });
    if (moved.count !== 1) refuse("Someone else just updated it — refresh the page.");
    await logAudit({
      action: "delivery.status_changed",
      summary: `${booking.vendor.name} delivery: ${deliveryStatusLabel(booking.status)} → ${deliveryStatusLabel(status)}`,
      user,
      entityType: "VendorDelivery",
      entityId: booking.id,
    });
    revalidatePath(booking.quoteId ? "/deliveries" : "/stock");
    if (booking.quoteId) revalidatePath(`/deals/${booking.quoteId}`);
    return { success: deliveryStatusLabel(status) };
  });
}
