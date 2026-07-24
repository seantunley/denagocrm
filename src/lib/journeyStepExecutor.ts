import { addDays, addHours, addMinutes } from "date-fns";
import { prisma } from "./db";
import { resolveTenantActor, resolveTenantMemberUser } from "./tenantActor";
import { sendEmail, renderTemplate } from "./email";
import { sendSms } from "./sms";
import { sendPushToAll } from "./push";
import { logAudit } from "./audit";
import { emitJourneyEvent } from "./journeyEvents";
import { journeyTemplateVars, type JourneyContext } from "./journeyContext";
import { executePlatformJourneyAction } from "./journeyPlatformActions";
import {
  evaluateConditions,
  parseConditionGroup,
  type JourneyStep,
} from "./journeyTypes";

export type StepResult = {
  status: "completed" | "skipped" | "waiting";
  note: string;
  nextStepId?: string | null;
  nextRunAt?: Date;
  output?: Record<string, unknown>;
};

function stringConfig(step: JourneyStep, key: string): string | null {
  const value = step.config[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberConfig(step: JourneyStep, key: string, fallback = 0): number {
  const value = Number(step.config[key]);
  return Number.isFinite(value) ? value : fallback;
}

function ids(context: JourneyContext) {
  const lead = (context.lead ?? {}) as Record<string, unknown>;
  const contact = (context.contact ?? {}) as Record<string, unknown>;
  return {
    leadId: typeof lead.id === "string" ? lead.id : null,
    contactId: typeof contact.id === "string" ? contact.id : null,
  };
}

async function fallbackUserId(context: JourneyContext, configured?: string | null) {
  if (configured) {
    const member = await resolveTenantMemberUser(configured);
    if (!member) throw new Error("The configured Journey user is not an active member of this tenant");
    return member.id;
  }
  const lead = (context.lead ?? {}) as Record<string, unknown>;
  const contact = (context.contact ?? {}) as Record<string, unknown>;
  const owner = lead.assignedToId ?? contact.ownerId;
  if (typeof owner === "string" && owner) {
    const member = await resolveTenantMemberUser(owner);
    if (member) return member.id;
  }
  const first = await resolveTenantActor();
  if (!first) throw new Error("No CRM users exist");
  return first.id;
}

function emailAddress(context: JourneyContext) {
  const lead = (context.lead ?? {}) as Record<string, unknown>;
  const contact = (context.contact ?? {}) as Record<string, unknown>;
  return String(contact.email ?? lead.email ?? "").trim() || null;
}

function phoneNumber(context: JourneyContext) {
  const lead = (context.lead ?? {}) as Record<string, unknown>;
  const contact = (context.contact ?? {}) as Record<string, unknown>;
  return String(contact.whatsapp ?? contact.phone ?? lead.phone ?? "").trim() || null;
}

function contactOptedOut(context: JourneyContext) {
  const contact = (context.contact ?? {}) as Record<string, unknown>;
  return contact.marketingOptOut === true;
}

async function recordCommunication(
  context: JourneyContext,
  type: "email" | "sms",
  subject: string | null,
  body: string,
  userId: string,
  journeyName: string
) {
  const { leadId, contactId } = ids(context);
  await prisma.communication.create({
    data: {
      type,
      direction: "outbound",
      subject,
      body: `[Journey: ${journeyName}]\n\n${body}`,
      leadId,
      contactId,
      userId,
    },
  });
}

export async function executeJourneyStep(args: {
  step: JourneyStep;
  context: JourneyContext;
  category: string;
  journeyName: string;
  runId: string;
  tenantId: string | null;
}): Promise<StepResult> {
  const { step, context, category, journeyName, runId, tenantId } = args;
  const vars = journeyTemplateVars(context);
  const { leadId, contactId } = ids(context);

  switch (step.type) {
    case "wait": {
      const amount = Math.max(1, numberConfig(step, "amount", 1));
      const unit = stringConfig(step, "unit") ?? "days";
      const now = new Date();
      const nextRunAt = unit === "minutes"
        ? addMinutes(now, amount)
        : unit === "hours"
          ? addHours(now, amount)
          : addDays(now, amount);
      return { status: "waiting", note: `Waiting ${amount} ${unit}`, nextRunAt };
    }

    case "condition": {
      const condition = parseConditionGroup(step.config.condition);
      const passed = evaluateConditions(condition, context);
      const branch = passed ? step.config.trueStepId : step.config.falseStepId;
      return {
        status: "completed",
        note: passed ? "Condition matched" : "Condition did not match",
        nextStepId: typeof branch === "string" && branch ? branch : step.nextStepId,
        output: { passed },
      };
    }

    case "stop":
      return { status: "completed", note: stringConfig(step, "reason") ?? "Journey stopped", nextStepId: null };

    case "send_email": {
      if (category === "marketing" && contactOptedOut(context)) {
        return { status: "skipped", note: "Marketing email skipped: contact opted out" };
      }
      const to = emailAddress(context);
      if (!to) return { status: "skipped", note: "Email skipped: no email address" };

      let subject = stringConfig(step, "subject") ?? "Message from Denago Cape Town";
      let text = stringConfig(step, "body") ?? "";
      let html = stringConfig(step, "htmlBody");
      const templateId = stringConfig(step, "emailTemplateId");
      if (templateId) {
        const template = await prisma.emailTemplate.findUnique({ where: { id: templateId } });
        if (!template) return { status: "skipped", note: "Email skipped: template was deleted or is not available to this tenant" };
        subject = template.subject;
        text = template.body;
      }
      subject = renderTemplate(subject, vars);
      text = renderTemplate(text, vars);
      html = html ? renderTemplate(html, vars) : null;
      if (!text && !html) return { status: "skipped", note: "Email skipped: message is empty" };

      const result = await sendEmail({ to, subject, text, html: html ?? undefined });
      if (!result.ok) throw new Error(result.error ?? "Email send failed");
      const userId = await fallbackUserId(context, stringConfig(step, "userId"));
      await recordCommunication(context, "email", subject, text || "HTML email", userId, journeyName);
      return { status: "completed", note: `Email sent to ${to}` };
    }

    case "send_sms": {
      if (category === "marketing" && contactOptedOut(context)) {
        return { status: "skipped", note: "Marketing SMS skipped: contact opted out" };
      }
      const to = phoneNumber(context);
      if (!to) return { status: "skipped", note: "SMS skipped: no phone number" };
      const message = renderTemplate(stringConfig(step, "message") ?? "", vars);
      if (!message) return { status: "skipped", note: "SMS skipped: message is empty" };
      const result = await sendSms(to, message);
      if (!result.ok) throw new Error(result.error ?? "SMS send failed");
      const userId = await fallbackUserId(context, stringConfig(step, "userId"));
      await recordCommunication(context, "sms", null, message, userId, journeyName);
      return { status: "completed", note: `SMS sent to ${to}` };
    }

    case "create_activity": {
      const userId = await fallbackUserId(context, stringConfig(step, "assignToId"));
      const dueDays = Math.max(0, numberConfig(step, "dueDays", 1));
      const summary = renderTemplate(stringConfig(step, "summary") ?? journeyName, vars);
      const activity = await prisma.activity.create({
        data: {
          type: stringConfig(step, "activityType") ?? "todo",
          summary,
          note: stringConfig(step, "note"),
          dueDate: addDays(new Date(), dueDays),
          leadId,
          contactId,
          assignedToId: userId,
          createdById: userId,
        },
      });
      return { status: "completed", note: `Activity created for ${dueDays} day(s)`, output: { activityId: activity.id } };
    }

    case "send_push": {
      const message = renderTemplate(stringConfig(step, "message") ?? journeyName, vars);
      await sendPushToAll({
        title: `Journey: ${journeyName}`,
        body: message,
        url: leadId ? `/leads/${leadId}` : contactId ? `/contacts/${contactId}` : "/automations",
      });
      return { status: "completed", note: "Team push notification sent" };
    }

    case "move_stage": {
      if (!leadId) return { status: "skipped", note: "Stage move skipped: no lead" };
      const stageId = stringConfig(step, "stageId");
      if (!stageId) return { status: "skipped", note: "Stage move skipped: no stage configured" };
      const stage = await prisma.pipelineStage.findFirst({ where: { id: stageId }, select: { id: true } });
      if (!stage) throw new Error("The configured pipeline stage is not available to this tenant");
      const max = await prisma.lead.aggregate({ where: { stageId }, _max: { position: true } });
      await prisma.lead.update({ where: { id: leadId }, data: { stageId, position: (max._max.position ?? 0) + 1 } });
      await emitJourneyEvent({
        type: "stage_entered",
        entityType: "lead",
        entityId: leadId,
        payload: { stageId, sourceRunId: runId, sourceStepId: step.id },
        dedupeKey: `journey-stage:${runId}:${step.id}:${stageId}`,
        tenantId,
      });
      return { status: "completed", note: "Lead moved to configured stage" };
    }

    case "assign_user": {
      if (!leadId) return { status: "skipped", note: "Assignment skipped: no lead" };
      const configured = stringConfig(step, "userId");
      if (!configured) return { status: "skipped", note: "Assignment skipped: no user configured" };
      const member = await resolveTenantMemberUser(configured);
      if (!member) throw new Error("The configured assignee is not an active member of this tenant");
      await prisma.lead.update({ where: { id: leadId }, data: { assignedToId: member.id } });
      return { status: "completed", note: "Lead assigned" };
    }

    case "add_tag":
    case "remove_tag": {
      if (!contactId) return { status: "skipped", note: "Tag step skipped: no contact" };
      const tagId = stringConfig(step, "tagId");
      if (!tagId) return { status: "skipped", note: "Tag step skipped: no tag configured" };
      const tag = await prisma.tag.findFirst({ where: { id: tagId }, select: { id: true } });
      if (!tag) throw new Error("The configured tag is not available to this tenant");
      await prisma.contact.update({
        where: { id: contactId },
        data: { tags: step.type === "add_tag" ? { connect: { id: tag.id } } : { disconnect: { id: tag.id } } },
      });
      return { status: "completed", note: step.type === "add_tag" ? "Tag added" : "Tag removed" };
    }
  }

  const platform = await executePlatformJourneyAction({
    step,
    context,
    journeyName,
    runId,
    tenantId,
    vars,
    leadId,
    contactId,
  });
  if (platform) return platform;

  await logAudit({
    action: "journey.unknown_step",
    summary: `Unknown journey step ${step.type}`,
    leadId,
    contactId,
    userName: "Journey engine",
  });
  return { status: "skipped", note: `Unknown step ${step.type}` };
}
