"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { actingTenantId } from "@/lib/actingTenant";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { logAudit } from "@/lib/audit";
import { requireLeadAccess } from "@/lib/permissions";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { financeStatusShort, isFinanceStatus } from "@/lib/dealFinanceRules";

const text = (formData: FormData, name: string, max: number) => String(formData.get(name) ?? "").trim().slice(0, max);

/**
 * Start or update a deal's finance (Sean, 2026-11-16): which finance house, their reference, where it stands and what
 * they said. A status change is dated (`statusAt`) — the Attention Centre chases from that date — and audited
 * old → new. Only a finance house already on the deal's suppliers — that is what makes a deal financed.
 * No applicant documents are taken here: they stay with the finance house.
 */
export async function saveDealFinance(leadId: string, formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireLeadAccess(leadId, "leads.edit");
    if (!(await isModuleEnabled("finance"))) refuse("Finance isn't switched on for this workspace (Settings → Modules).");
    const tenantId = await actingTenantId();
    const lead = await prisma.lead.findFirst({ where: { id: leadId, tenantId, deletedAt: null }, select: { id: true, contactId: true } });
    if (!lead) refuse("That deal is no longer there — refresh the page.");

    const status = text(formData, "status", 40);
    if (!isFinanceStatus(status)) refuse("Choose where the finance stands.");
    const reference = text(formData, "reference", 80) || null;
    const note = text(formData, "note", 1000) || null;
    const vendorId = text(formData, "vendorId", 64);
    // THE VERSION THE FORM SHOWED (its updatedAt; "" when it showed no finance). A save is only ever made over that
    // version: a stale form — or a DAX card shown before a colleague's edit — is refused, never laid over newer work.
    // statusAt stays the chaser's clock alone.
    const shown = text(formData, "version", 40);

    // ONE TRANSACTION, THE LEAD ROW HELD (follow-up to the #1137 review): taking the finance house off the deal
    // (removeDealVendor) holds the same row, so a finance can't be started on a supplier that is being removed.
    const saved = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Lead" WHERE "id" = ${leadId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      // A finance house ON THIS DEAL only — the form lists those, and the server holds to it whatever is posted. A deal
      // is financed because someone added the finance house to its suppliers; a cash deal never is.
      const link = await tx.dealVendor.findFirst({
        where: { tenantId, leadId, vendorId, vendor: { deletedAt: null, kind: "finance" } },
        select: { vendor: { select: { id: true, name: true } } },
      });
      if (!link) refuse("Add the finance house to this deal's suppliers first, then choose it here.");
      const vendor = link.vendor;
      const existing = await tx.dealFinance.findFirst({
        where: { tenantId, leadId },
        select: { id: true, status: true, statusAt: true, updatedAt: true, vendorId: true, reference: true, note: true, vendor: { select: { name: true } } },
      });
      if ((existing?.updatedAt.toISOString() ?? "") !== shown) {
        refuse(existing ? "Someone else changed the finance since you opened it — refresh to see their change." : "The finance on this deal is no longer there — refresh the page.");
      }
      if (!existing) {
        try {
          const row = await tx.dealFinance.create({
            data: { tenantId, leadId, vendorId: vendor.id, reference, status, note, createdById: user.id },
            select: { id: true },
          });
          return { entityId: row.id, summary: `Finance started with ${vendor.name}${reference ? ` (${reference})` : ""}: ${financeStatusShort(status)}` };
        } catch (error) {
          // One per deal (the unique index): two people starting it at once.
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") refuse("Someone else just started the finance on this deal — refresh the page.");
          throw error;
        }
      }
      const moved = existing.status !== status;
      if (!moved && existing.vendorId === vendor.id && existing.reference === reference && existing.note === note) return null;
      // Compare-and-swap on that version: two saves at once — any field — can't both land; the second is refused.
      const updated = await tx.dealFinance.updateMany({
        where: { id: existing.id, tenantId, updatedAt: existing.updatedAt },
        data: { vendorId: vendor.id, reference, note, status, ...(moved ? { statusAt: new Date() } : {}) },
      });
      if (updated.count !== 1) refuse("Someone else just updated the finance — refresh the page.");
      const changes = [
        moved ? `${financeStatusShort(existing.status)} → ${financeStatusShort(status)}` : null,
        existing.vendorId !== vendor.id ? `finance house ${existing.vendor.name} → ${vendor.name}` : null,
        existing.reference !== reference ? `reference ${existing.reference ?? "none"} → ${reference ?? "none"}` : null,
        existing.note !== note ? "note updated" : null,
      ].filter(Boolean);
      return { entityId: existing.id, summary: `Finance with ${vendor.name}: ${changes.join("; ")}` };
    });
    if (!saved) return { success: "Nothing changed" };
    const { entityId, summary } = saved;

    await logAudit({ action: "finance.updated", summary, leadId, ...(lead.contactId ? { contactId: lead.contactId } : {}), user, entityType: "DealFinance", entityId });
    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/deals/[id]", "page");
    revalidatePath("/leads/attention");
    return { success: `Finance: ${financeStatusShort(status)}` };
  });
}
