"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { actingTenantId } from "@/lib/actingTenant";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { logAudit } from "@/lib/audit";
import { requireLeadAccess } from "@/lib/permissions";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { linkVendorToDeal } from "@/lib/dealVendors";
import { financeStatusShort, isFinanceStatus } from "@/lib/dealFinanceRules";

const text = (formData: FormData, name: string, max: number) => String(formData.get(name) ?? "").trim().slice(0, max);

/**
 * Start or update a deal's finance (Sean, 2026-11-16): which finance house, their reference, where it stands and what
 * they said. A status change is dated (`statusAt`) — the Attention Centre chases from that date — and audited
 * old → new. The finance house is added to the deal's suppliers, so the deal file asks for its papers.
 * No applicant documents are taken here: they stay with the finance house.
 */
export async function saveDealFinance(leadId: string, formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireLeadAccess(leadId, "leads.edit");
    if (!(await isModuleEnabled("suppliers"))) refuse("Suppliers aren't switched on for this workspace — the finance house is kept there.");
    const tenantId = await actingTenantId();
    const lead = await prisma.lead.findFirst({ where: { id: leadId, tenantId, deletedAt: null }, select: { id: true, contactId: true } });
    if (!lead) refuse("That deal is no longer there — refresh the page.");

    // A finance house only — the form lists those, and the server holds to it whatever is posted.
    const vendor = await prisma.vendor.findFirst({
      where: { id: text(formData, "vendorId", 64), tenantId, deletedAt: null, kind: "finance" },
      select: { id: true, name: true },
    });
    if (!vendor) refuse("Choose the finance house from the list.");
    const status = text(formData, "status", 40);
    if (!isFinanceStatus(status)) refuse("Choose where the finance stands.");
    const reference = text(formData, "reference", 80) || null;
    const note = text(formData, "note", 1000) || null;

    const existing = await prisma.dealFinance.findFirst({
      where: { tenantId, leadId },
      select: { id: true, status: true, statusAt: true, vendorId: true, reference: true, note: true, vendor: { select: { name: true } } },
    });
    let entityId: string;
    let summary: string;
    if (!existing) {
      try {
        const row = await prisma.dealFinance.create({
          data: { tenantId, leadId, vendorId: vendor.id, reference, status, note, createdById: user.id },
          select: { id: true },
        });
        entityId = row.id;
      } catch (error) {
        // One per deal (the unique index): two people starting it at once.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") refuse("Someone else just started the finance on this deal — refresh the page.");
        throw error;
      }
      summary = `Finance started with ${vendor.name}${reference ? ` (${reference})` : ""}: ${financeStatusShort(status)}`;
    } else {
      const moved = existing.status !== status;
      if (!moved && existing.vendorId === vendor.id && existing.reference === reference && existing.note === note) return { success: "Nothing changed" };
      // Only from what was read: two people saving at once can't silently overwrite each other's status.
      const updated = await prisma.dealFinance.updateMany({
        where: { id: existing.id, tenantId, status: existing.status, statusAt: existing.statusAt },
        data: { vendorId: vendor.id, reference, note, status, ...(moved ? { statusAt: new Date() } : {}) },
      });
      if (updated.count !== 1) refuse("Someone else just updated the finance — refresh the page.");
      entityId = existing.id;
      const changes = [
        moved ? `${financeStatusShort(existing.status)} → ${financeStatusShort(status)}` : null,
        existing.vendorId !== vendor.id ? `finance house ${existing.vendor.name} → ${vendor.name}` : null,
        existing.reference !== reference ? `reference ${existing.reference ?? "none"} → ${reference ?? "none"}` : null,
        existing.note !== note ? "note updated" : null,
      ].filter(Boolean);
      summary = `Finance with ${vendor.name}: ${changes.join("; ")}`;
    }

    await linkVendorToDeal({ tenantId, quote: { id: leadId, leadId }, vendorId: vendor.id, userId: user.id });
    await logAudit({ action: "finance.updated", summary, leadId, ...(lead.contactId ? { contactId: lead.contactId } : {}), user, entityType: "DealFinance", entityId });
    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/deals/[id]", "page");
    revalidatePath("/leads/attention");
    return { success: `Finance: ${financeStatusShort(status)}` };
  });
}
