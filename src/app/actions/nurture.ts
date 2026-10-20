"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { asActionResult, refuse } from "@/lib/actionResult";
import { actingTenantId } from "@/lib/actingTenant";
import { requireLeadAccess, hasPermission } from "@/lib/permissions";
import { resolveAssignableUser } from "@/lib/tenantActor";
import { logAuditStrict, GOVERNANCE_TX } from "@/lib/audit";
import { nurtureReasonLabel, parseNurtureForm } from "@/lib/leadNurture";

function refresh(leadId: string) {
  for (const path of ["/leads", "/leads/nurture", "/leads/list", "/forecast", "/", `/leads/${leadId}`]) revalidatePath(path);
}

/** A conditional write and its review task/audit commit together. A stale form cannot reopen a closed deal. */
export async function saveLeadNurture(leadId: string, form: FormData) {
  return asActionResult(async () => {
    const user = await requireLeadAccess(leadId, "leads.change_stage");
    if (!(await hasPermission(user, "activities.manage"))) refuse("You need activity permission to schedule the nurture review.");
    const input = parseNurtureForm(form);
    if ("error" in input) refuse(input.error);
    const tenantId = await actingTenantId();
    const before = await prisma.lead.findFirst({ where: { id: leadId, tenantId, deletedAt: null } });
    if (!before || !["open", "nurture"].includes(before.status)) refuse("Only open or nurtured leads can be moved to nurture.");
    if (before.assignedToId !== input.assignedToId && !(await hasPermission(user, "leads.assign"))) refuse("You do not have permission to change the salesperson.");
    const owner = await resolveAssignableUser(input.assignedToId, "salesperson");
    if (!owner) refuse("Choose an available salesperson.");
    await prisma.$transaction(async (tx) => {
      const changed = await tx.lead.updateMany({
        where: { id: leadId, tenantId, status: before.status, deletedAt: null, updatedAt: before.updatedAt },
        data: {
          status: "nurture", assignedToId: owner.id,
          nurtureSince: before.nurtureSince ?? new Date(), nurtureReason: input.reason,
          nurtureInterest: input.interest, nurtureTrigger: input.trigger, nurtureReviewAt: input.reviewAt,
        },
      });
      if (changed.count !== 1) refuse("This lead changed while you were editing. Refresh and try again.");
      const activityData = { summary: `Review future interest: ${input.interest}`, note: input.trigger, dueDate: input.reviewAt, assignedToId: owner.id };
      const updated = before.nurtureActivityId ? await tx.activity.updateMany({
        where: { id: before.nurtureActivityId, leadId, tenantId, status: "planned" }, data: activityData,
      }) : { count: 0 };
      if (!updated.count) {
        const task = await tx.activity.create({ data: { ...activityData, tenantId, leadId, type: "todo", createdById: user.id } });
        await tx.lead.update({ where: { id: leadId, tenantId }, data: { nurtureActivityId: task.id } });
      }
      await logAuditStrict({
        action: before.status === "nurture" ? "lead.nurture_updated" : "lead.nurtured",
        summary: `${before.status === "nurture" ? "Updated nurture for" : "Moved to nurture:"} “${before.title}” — ${nurtureReasonLabel(input.reason)}; ${input.interest}`,
        leadId, contactId: before.contactId, user,
        before: { status: before.status, nurtureReviewAt: before.nurtureReviewAt },
        after: { status: "nurture", ...input },
      }, tx);
    }, GOVERNANCE_TX);
    refresh(leadId);
    return { success: "Saved to nurture. Review scheduled; existing commitments kept.", redirectTo: "/leads/nurture" };
  });
}

/** Staff explicitly choose whose product/timing trigger has been met. Never sends a customer message. */
export async function queueNurtureFollowUp(leadId: string) {
  return asActionResult(async () => {
    const user = await requireLeadAccess(leadId, "activities.manage");
    const tenantId = await actingTenantId();
    const before = await prisma.lead.findFirst({ where: { id: leadId, tenantId, status: "nurture", deletedAt: null } });
    if (!before?.assignedToId) refuse("This lead needs a responsible salesperson before a follow-up can be queued.");
    const owner = await resolveAssignableUser(before.assignedToId, "salesperson");
    if (!owner) refuse("Assign an available salesperson first.");
    await prisma.$transaction(async (tx) => {
      const now = new Date();
      const changed = await tx.lead.updateMany({
        where: { id: leadId, tenantId, status: "nurture", deletedAt: null, updatedAt: before.updatedAt },
        data: { nurtureReviewAt: now },
      });
      if (changed.count !== 1) refuse("This lead changed. Refresh before queuing a follow-up.");
      const data = { summary: `Follow up: ${before.nurtureInterest}`, note: before.nurtureTrigger, dueDate: now, assignedToId: owner.id };
      const updated = before.nurtureActivityId ? await tx.activity.updateMany({
        where: { id: before.nurtureActivityId, leadId, tenantId, status: "planned" }, data,
      }) : { count: 0 };
      if (!updated.count) {
        const task = await tx.activity.create({ data: { ...data, tenantId, leadId, type: "call", createdById: user.id } });
        await tx.lead.update({ where: { id: leadId, tenantId }, data: { nurtureActivityId: task.id } });
      }
      await logAuditStrict({ action: "lead.nurture_follow_up", summary: `Queued follow-up for “${before.title}” — ${before.nurtureInterest}`, leadId, contactId: before.contactId, user }, tx);
    }, GOVERNANCE_TX);
    refresh(leadId);
    return { success: "Follow-up queued for the salesperson. No customer message sent." };
  });
}
