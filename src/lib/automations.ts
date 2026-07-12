import crypto from "crypto";
import { addDays, subDays } from "date-fns";
import { prisma } from "./db";
import { logAudit } from "./audit";
import { sendEmail, renderTemplate, leadVars } from "./email";
import { sendPushToAll } from "./push";
import { emitJourneyEvent } from "./journeys";

export const LEAD_TRIGGERS = [
  "lead_created",
  "stage_entered",
  "lead_won",
  "lead_lost",
  "quote_signed",
  "quote_declined",
  "delivered",
  "referral_earned",
] as const;
export type LeadTrigger = (typeof LEAD_TRIGGERS)[number];

type LeadForRules = NonNullable<Awaited<ReturnType<typeof loadLead>>>;
type JourneyEventOptions = {
  eventKey?: string;
  payload?: Record<string, unknown>;
};

const SOURCE_GUARDED_EVENTS = new Set<LeadTrigger>([
  "quote_signed",
  "quote_declined",
  "delivered",
  "referral_earned",
]);

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
    pushMessage: string | null;
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
          summary: `${rule.activitySummary || rule.name} — ${lead.name}`,
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
      const template = await prisma.emailTemplate.findUnique({ where: { id: rule.emailTemplateId } });
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
      await prisma.lead.update({ where: { id: lead.id }, data: { assignedToId: rule.assignToId } });
      return "assigned";
    }
    case "send_push": {
      const vars = leadVars(lead);
      await sendPushToAll({
        title: `🤖 ${rule.name}`,
        body: renderTemplate(rule.pushMessage || "{{name}}", vars),
        url: `/leads/${lead.id}`,
      });
      return "push sent";
    }
    default:
      return `skipped: unknown action ${rule.action}`;
  }
}

async function logRule(
  ruleId: string,
  leadId: string,
  note: string,
  ruleName?: string,
  contactId?: string | null
) {
  await prisma.automationLog.create({ data: { ruleId, leadId, note } }).catch(() => {});
  if (ruleName && !note.startsWith("skipped")) {
    await logAudit({
      action: "automation.ran",
      summary: `Automation “${ruleName}”: ${note}`,
      leadId,
      contactId,
      userName: "Automation",
    });
  }
}

function conditionsHold(
  rule: { conditionSources: string | null; minValueCents: number | null },
  lead: { source: string; valueCents: number }
): boolean {
  if (rule.conditionSources) {
    const allowed = rule.conditionSources.split(",").map((s) => s.trim()).filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(lead.source)) return false;
  }
  if (rule.minValueCents != null && lead.valueCents < rule.minValueCents) return false;
  return true;
}

async function queueAdvancedJourney(
  trigger: LeadTrigger,
  lead: LeadForRules,
  options: JourneyEventOptions
) {
  const stateKey = options.eventKey ?? (
    SOURCE_GUARDED_EVENTS.has(trigger)
      ? `${trigger}:${lead.id}:${crypto.randomUUID()}`
      : [trigger, lead.stageId, lead.status, lead.updatedAt.toISOString()].join(":")
  );
  await emitJourneyEvent({
    type: trigger,
    entityType: "lead",
    entityId: lead.id,
    payload: {
      stageId: lead.stageId,
      status: lead.status,
      ...(options.payload ?? {}),
    },
    dedupeKey: stateKey,
  });
}

/** Fires legacy rules and also emits the durable event used by advanced journeys. */
export async function runLeadAutomations(
  trigger: LeadTrigger,
  leadId: string,
  depth = 0,
  options: JourneyEventOptions = {}
): Promise<void> {
  let lead: LeadForRules | null = null;
  try {
    lead = await loadLead(leadId);
    if (!lead) return;
    const rules = await prisma.automationRule.findMany({ where: { active: true, trigger } });
    for (const rule of rules) {
      if (trigger === "stage_entered" && rule.triggerStageId !== lead.stageId) continue;
      if (!conditionsHold(rule, lead)) continue;
      try {
        const note = await applyRule(rule, lead, depth);
        await logRule(rule.id, lead.id, note, rule.name, lead.contactId);
      } catch (err) {
        await logRule(rule.id, lead.id, `error: ${err instanceof Error ? err.message : "unknown"}`);
      }
    }
  } catch {
    // Legacy automations must never break the main CRM flow.
  }

  try {
    lead = (await loadLead(leadId)) ?? lead;
    if (lead) await queueAdvancedJourney(trigger, lead, options);
  } catch {
    // Journey event delivery is durable but still best-effort from the caller.
  }
}

/** Fires legacy idle-lead rules. Advanced idle journeys are scheduled separately. */
export async function runIdleAutomations(): Promise<number> {
  let fired = 0;
  const rules = await prisma.automationRule.findMany({ where: { active: true, trigger: "lead_idle" } });
  for (const rule of rules) {
    const days = rule.idleDays ?? 3;
    const idleLeads = await prisma.lead.findMany({
      where: { status: "open", updatedAt: { lt: subDays(new Date(), days) } },
      include: { product: true, assignedTo: true, stage: true },
    });
    for (const lead of idleLeads) {
      const already = await prisma.automationLog.findFirst({ where: { ruleId: rule.id, leadId: lead.id } });
      if (already || !conditionsHold(rule, lead)) continue;
      try {
        const note = await applyRule(rule, lead, 0);
        await logRule(rule.id, lead.id, note, rule.name, lead.contactId);
        fired++;
      } catch (err) {
        await logRule(rule.id, lead.id, `error: ${err instanceof Error ? err.message : "unknown"}`);
      }
    }
  }
  return fired;
}
