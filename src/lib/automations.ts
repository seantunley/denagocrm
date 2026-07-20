import { subDays } from "date-fns";
import { prisma } from "./db";
import { logAudit } from "./audit";
import { sendEmail, renderTemplate, leadVars } from "./email";
import { sendPushToAll } from "./push";
import { nextStepDueDate } from "./businessHours";
import { getNextStepScheduling } from "./nextStepConfig";
import { FOLLOW_UP_TYPE, isOpenFutureFollowUp } from "./followUp";

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
      const dueDate = nextStepDueDate(
        new Date(),
        rule.activityDueDays ?? 1,
        await getNextStepScheduling()
      );
      await prisma.activity.create({
        data: {
          type: rule.activityType ?? "todo",
          summary: `${rule.activitySummary || rule.name} — ${lead.name}`,
          dueDate,
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
  await prisma.automationLog
    .create({ data: { ruleId, leadId, note } })
    .catch(() => {});
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

/** Fires event-based rules for a lead. */
export async function runLeadAutomations(
  trigger: LeadTrigger,
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
      if (!conditionsHold(rule, lead)) continue;
      try {
        const note = await applyRule(rule, lead, depth);
        await logRule(rule.id, lead.id, note, rule.name, lead.contactId);
      } catch (err) {
        await logRule(rule.id, lead.id, `error: ${err instanceof Error ? err.message : "unknown"}`);
      }
    }
  } catch {
    // Automations must never break the main flow
  }
}

/**
 * The most recent moment a lead saw real engagement. `updatedAt` alone is not
 * enough — a lead can look stale on its row while a quote was just sent, a
 * WhatsApp came in, or an activity is scheduled. We take the latest of the
 * lead row, its newest communication, its newest activity (created or due), and
 * its newest quote. Returns null when a candidate should be skipped entirely
 * because it has a quote still pending a decision (a quote-pending state is not
 * "gone quiet").
 *
 * A logged activity's `createdAt` always counts (it is real past engagement),
 * but a future `dueDate` only counts for OPEN ("planned") activities — a
 * canceled or completed activity whose due date happens to sit in the future is
 * not a scheduled touch and must not suppress the gone-quiet nudge.
 *
 * Engagement is frequently recorded against the CONTACT rather than the lead:
 * an inbound WhatsApp matches a contact first, and the contact activity panel
 * schedules activities with a `contactId` and no `leadId`. So when the lead has
 * a `contactId` we widen every aggregate to include contact-linked rows too,
 * otherwise an active customer's lead could still be flagged idle.
 */
async function lastEngagementAt(
  leadId: string,
  contactId: string | null,
  rowUpdatedAt: Date,
): Promise<Date | null> {
  const [pendingQuote, commAgg, activityAgg, plannedActivityAgg, quoteAgg] = await Promise.all([
    prisma.quote.findFirst({
      where: {
        status: "sent",
        signedAt: null,
        supersededAt: null,
        deletedAt: null,
        OR: [{ leadId }, ...(contactId ? [{ contactId }] : [])],
      },
      select: { id: true },
    }),
    prisma.communication.aggregate({
      where: { OR: [{ leadId }, ...(contactId ? [{ contactId }] : [])] },
      _max: { occurredAt: true },
    }),
    prisma.activity.aggregate({
      where: { OR: [{ leadId }, ...(contactId ? [{ contactId }] : [])] },
      _max: { createdAt: true },
    }),
    prisma.activity.aggregate({
      where: {
        status: "planned",
        OR: [{ leadId }, ...(contactId ? [{ contactId }] : [])],
      },
      _max: { dueDate: true },
    }),
    prisma.quote.aggregate({
      where: {
        deletedAt: null,
        OR: [{ leadId }, ...(contactId ? [{ contactId }] : [])],
      },
      _max: { updatedAt: true },
    }),
  ]);

  // A quote awaiting the customer's decision means the deal is live, not quiet.
  if (pendingQuote) return null;

  const candidates: Date[] = [rowUpdatedAt];
  if (commAgg._max.occurredAt) candidates.push(commAgg._max.occurredAt);
  if (activityAgg._max.createdAt) candidates.push(activityAgg._max.createdAt);
  if (plannedActivityAgg._max.dueDate) candidates.push(plannedActivityAgg._max.dueDate);
  if (quoteAgg._max.updatedAt) candidates.push(quoteAgg._max.updatedAt);

  return candidates.reduce((latest, d) => (d > latest ? d : latest), rowUpdatedAt);
}

/**
 * Fires idle-lead rules: open leads whose last REAL engagement is older than N
 * days. Engagement means the lead row, communications, activities or quotes —
 * not just the row's `updatedAt`. Leads with a quote still pending a decision
 * are never treated as idle. Each rule fires at most once per lead. Returns how
 * many rules fired.
 *
 * A lead with an OPEN (status "planned") follow-up whose due date is still in
 * the future is never treated as gone quiet either — the rep has an explicit
 * check-back scheduled, so the nudge is suppressed until the follow-up is due.
 */
export async function runIdleAutomations(): Promise<number> {
  let fired = 0;
  const now = new Date();
  const rules = await prisma.automationRule.findMany({
    where: { active: true, trigger: "lead_idle" },
  });
  for (const rule of rules) {
    const days = rule.idleDays ?? 3;
    const cutoff = subDays(now, days);
    // Narrow to leads whose own row is already stale; a lead touched more
    // recently than the cutoff is engaged by definition and can't be idle.
    const candidates = await prisma.lead.findMany({
      where: { status: "open", updatedAt: { lt: cutoff } },
      include: { product: true, assignedTo: true, stage: true },
    });
    for (const lead of candidates) {
      const already = await prisma.automationLog.findFirst({
        where: { ruleId: rule.id, leadId: lead.id },
      });
      if (already) continue;
      if (!conditionsHold(rule, lead)) continue;

      const lastEngagement = await lastEngagementAt(
        lead.id,
        lead.contactId,
        lead.updatedAt,
      );
      // null = quote pending; >= cutoff = real recent engagement. Either way,
      // the lead is not "gone quiet".
      if (lastEngagement === null || lastEngagement >= cutoff) continue;

      // Also suppress the gone-quiet nudge while an open, future follow-up
      // exists — including contact-scoped follow-ups (booked from the contact
      // panel with no leadId).
      const plannedFollowUps = await prisma.activity.findMany({
        where: {
          type: FOLLOW_UP_TYPE,
          status: "planned",
          OR: [
            { leadId: lead.id },
            ...(lead.contactId ? [{ contactId: lead.contactId }] : []),
          ],
        },
        select: { type: true, status: true, dueDate: true },
      });
      if (plannedFollowUps.some((a) => isOpenFutureFollowUp(a, now))) continue;

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
