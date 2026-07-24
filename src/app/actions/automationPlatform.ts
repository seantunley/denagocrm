"use server";

import { revalidatePath } from "next/cache";
import { getActiveTenantId } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { logAuditStrict } from "@/lib/audit";
import { requirePermission } from "@/lib/permissions";

async function automationContext() {
  const user = await requirePermission("journeys.manage");
  return { user, tenantId: await getActiveTenantId() };
}

export async function decideAutomationApproval(
  id: string,
  decision: "approved" | "rejected",
  formData: FormData,
) {
  const { user, tenantId } = await automationContext();
  const note = String(formData.get("note") ?? "").trim() || null;
  const before = await prisma.automationApprovalRequest.findFirst({
    where: { id, tenantId, status: "pending" },
  });
  if (!before) throw new Error("Approval request not found or already decided");
  if (before.assignedToId && before.assignedToId !== user.id && user.role !== "owner") {
    throw new Error("This approval is assigned to another user");
  }
  const updated = await prisma.automationApprovalRequest.update({
    where: { id },
    data: { status: decision, decidedById: user.id, decidedAt: new Date(), decisionNote: note },
  });
  await logAuditStrict({
    action: `automation.approval_${decision}`,
    summary: `${decision === "approved" ? "Approved" : "Rejected"} automation request “${updated.title}”`,
    entityType: "AutomationApprovalRequest",
    entityId: updated.id,
    contactId: updated.contactId,
    leadId: updated.leadId,
    user,
    before,
    after: updated,
  });
  revalidatePath("/automations/approvals");
}

export async function retryAutomationOutbox(id: string) {
  const { user, tenantId } = await automationContext();
  const before = await prisma.automationOutbox.findFirst({ where: { id, tenantId } });
  if (!before) throw new Error("Automation queue item not found");
  if (!new Set(["failed", "blocked"]).has(before.status)) throw new Error("Only failed or blocked items can be retried");
  if (before.kind === "xero.draft_invoice") {
    throw new Error("Connect the Xero integration before retrying this request");
  }
  const updated = await prisma.automationOutbox.update({
    where: { id },
    data: { status: "pending", attempts: 0, availableAt: new Date(), completedAt: null, error: null },
  });
  await logAuditStrict({
    action: "automation.outbox_retried",
    summary: `Retried ${updated.kind} automation action`,
    entityType: "AutomationOutbox",
    entityId: updated.id,
    user,
    before,
    after: updated,
  });
  revalidatePath("/automations/outbox");
}

export async function cancelAutomationOutbox(id: string, formData: FormData) {
  const { user, tenantId } = await automationContext();
  const reason = String(formData.get("reason") ?? "").trim() || "Cancelled by an administrator";
  const before = await prisma.automationOutbox.findFirst({
    where: { id, tenantId, status: { in: ["pending", "failed", "blocked"] } },
  });
  if (!before) throw new Error("Queue item not found or no longer cancellable");
  const updated = await prisma.automationOutbox.update({
    where: { id },
    data: { status: "failed", error: reason, completedAt: new Date() },
  });
  await logAuditStrict({
    action: "automation.outbox_cancelled",
    summary: `Cancelled ${updated.kind} automation action — ${reason}`,
    entityType: "AutomationOutbox",
    entityId: updated.id,
    user,
    before,
    after: updated,
  });
  revalidatePath("/automations/outbox");
}

export async function updateStockTransferRequest(
  id: string,
  status: "approved" | "in_transit" | "received" | "cancelled",
  formData: FormData,
) {
  void formData;
  const user = await requirePermission("stock.manage");
  const tenantId = await getActiveTenantId();
  const before = await prisma.stockTransferRequest.findFirst({ where: { id, tenantId } });
  if (!before) throw new Error("Stock-transfer request not found");
  const allowed: Record<string, string[]> = {
    requested: ["approved", "cancelled"],
    approved: ["in_transit", "cancelled"],
    in_transit: ["received", "cancelled"],
  };
  if (!(allowed[before.status] ?? []).includes(status)) throw new Error("Invalid stock-transfer transition");
  const updated = await prisma.stockTransferRequest.update({ where: { id }, data: { status } });
  await logAuditStrict({
    action: `stock_transfer.${status}`,
    summary: `Stock transfer to ${updated.toBranch} marked ${status.replaceAll("_", " ")}`,
    entityType: "StockTransferRequest",
    entityId: updated.id,
    user,
    before,
    after: updated,
  });
  revalidatePath("/automations/transfers");
}
