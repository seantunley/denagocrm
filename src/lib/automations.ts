import { addDays, subDays } from "date-fns";
import { prisma } from "./db";
import { sendEmail, renderTemplate, leadVars } from "./email";

type LeadForRules = NonNullable<Awaited<ReturnType<typeof loadLead>>>;

function loadLead(id: string) {
  return prisma.lead.findUnique({
    where: { id },
    include: { product: true, assignedTo: true, stage: true },
  });
}

async function fallbackUserId(lead: LeadForRules, ruleAssignee?: string | null) {
  if (ruleAssignee) return ruleAssignee;
  if (lead.assignedToId) return lead.assignedToId;
  const first = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!first) throw new Error("No users exist");
  return first.id;
}

async function applyRule(
  rule: {
    id: string;
    name: string;
    action: string;
    activityType: string | null;
    activitySummary: string | null;
    activityDueDays: number | null;
    emailTemplateId: string | null;
    targetStageId: string | null;
    assignToId: string | null;
  },
  lead: LeadForRules,
  depth: number
): Promise<string> {
  switch (rule.action) {
    case "create_activity": {
      const userId = await fallbackUserId(lead, rule.assignToId);
      await prisma.activity.create({
        data: {
          type: rule.activityType ?? "todo",
          summary: rule.activitySummary || rule.name,
          dueDate: addDays(new Date(), rule.activityDueDays ?? 1),
          leadId: lead.id,
          assignedToId: userId,
          createdById: userId,
        },
      });
      return "activity created";
    }
    case "send_email": {
      if (!lead.email) return "skipped: lead has no email";
      if (!rule.emailTemplateId) return "skipped: no template configured";
      const template = await prisma.emailTemplate.findUnique({
        where: { id: rule.emailTemplateId },
      });
      if (!template) return "skipped: template deleted";
      const vars = leadVars(lead);
      const subject = renderTemplate(template.subject, vars);
      const body = renderTemplate(template.body, vars);
      const result = await sendEmail({ to: lead.email, subject, text: body });
      if (!result.ok) return `email failed: ${result.error}`;
      const userId = await fallbackUserId(lead, rule.assignToId);
      await prisma.communication.create({
        data: {
          type: "email",
          direction: "outbound",
          subject,
          body: `[Automation: ${rule.name}]\n\n${body}`,
          leadId: lead.id,
          contactId: lead.contactId,
          userId,
        },
      });
      return "email sent";
    }
    case "move_stage": {
      if (!rule.targetStageId || rule.targetStageId === lead.stageId) {
        return "skipped: already in target stage";
      }
      const max = await prisma.lead.aggregate({
        where: { stageId: rule.targetStageId },
        _max: { position: true },
      });
      await prisma.lead.update({
        where: { id: lead.id },
        data: { stageId: rule.targetStageId, position: (max._max.position ?? 0) + 1 },
      });
      if (depth < 2) await runLeadAutomations("stage_entered", lead.id, depth + 1);
      return "moved stage";
    }
    case "assign_user": {
      if (!rule.assignToId) return "skipped: no assignee configured";
      await prisma.lead.update({
        where: { id: lead.id },
        data: { assignedToId: rule.assignToId },
      });
      return "assigned";
    }
    default:
      return `skipped: unknown action ${rule.action}`;
  }
}

async function logRule(ruleId: string, leadId: string, note: string) {
  await prisma.automationLog
    .create({ data: { ruleId, leadId, note } })
    .catch(() => {});
}

/** Fires event-based rules (lead_created / stage_entered) for a lead. */
export async function runLeadAutomations(
  trigger: "lead_created" | "stage_entered",
  leadId: string,
  depth = 0
): Promise<void> {
  try {
    const lead = await loadLead(leadId);
    if (!lead) return;
    const rules = await prisma.automationRule.findMany({
      where: { active: true, trigger },
    });
    for (const rule of rules) {
      if (trigger === "stage_entered" && rule.triggerStageId !== lead.stageId) continue;
      try {
        const note = await applyRule(rule, lead, depth);
        await logRule(rule.id, lead.id, note);
      } catch (err) {
        await logRule(rule.id, lead.id, `error: ${err instanceof Error ? err.message : "unknown"}`);
      }
    }
  } catch {
    // Automations must never break the main flow
  }
}

/**
 * Fires idle-lead rules: open leads untouched for N days.
 * Each rule fires at most once per lead. Returns how many rules fired.
 */
export async function runIdleAutomations(): Promise<number> {
  let fired = 0;
  const rules = await prisma.automationRule.findMany({
    where: { active: true, trigger: "lead_idle" },
  });
  for (const rule of rules) {
    const days = rule.idleDays ?? 3;
    const idleLeads = await prisma.lead.findMany({
      where: { status: "open", updatedAt: { lt: subDays(new Date(), days) } },
      include: { product: true, assignedTo: true, stage: true },
    });
    for (const lead of idleLeads) {
      const already = await prisma.automationLog.findFirst({
        where: { ruleId: rule.id, leadId: lead.id },
      });
      if (already) continue;
      try {
        const note = await applyRule(rule, lead, 0);
        await logRule(rule.id, lead.id, note);
        fired++;
      } catch (err) {
        await logRule(rule.id, lead.id, `error: ${err instanceof Error ? err.message : "unknown"}`);
      }
    }
  }
  return fired;
}
