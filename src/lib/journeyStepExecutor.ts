import { addDays, addHours, addMinutes } from "date-fns";
import { prisma, basePrisma } from "./db";
import { resolveTenantActor } from "./tenantActor";
import { sendEmail, renderTemplate } from "./email";
import { sendSms } from "./sms";
import { sendPushToAll } from "./push";
import { logAudit } from "./audit";
import { emitJourneyEvent } from "./journeyEvents";
import { canContactPerson } from "./communicationPolicy";
import { JourneyContext, journeyTemplateVars } from "./journeyContext";
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
  if (configured) return configured;
  const lead = (context.lead ?? {}) as Record<string, unknown>;
  const contact = (context.contact ?? {}) as Record<string, unknown>;
  const owner = lead.assignedToId ?? contact.ownerId;
  if (typeof owner === "string" && owner) return owner;
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

/**
 * The ONE consent gate — the same one campaigns, surveys and lifecycle mail use.
 *
 * This read `contact.marketingOptOut` and nothing else, so a journey happily
 * emailed someone who had withdrawn consent via ConsentRecord or unsubscribed
 * in the portal, at 3am, with no frequency cap. Those rules already existed;
 * they just lived in a policy this file had never heard of.
 *
 * A contact we cannot identify is not contactable: no id means no way to check,
 * and the safe answer to "may we market to this person" is no.
 */
async function marketingBlocked(context: JourneyContext, channel: "email" | "sms"): Promise<string | null> {
  const contact = (context.contact ?? {}) as Record<string, unknown>;
  const contactId = typeof contact.id === "string" ? contact.id : null;
  if (!contactId) return "no contact record to check consent against";
  const tenantId = typeof contact.tenantId === "string" ? contact.tenantId : null;
  const verdict = await canContactPerson({
    contactId,
    tenantId,
    purpose: "marketing",
    requestedChannel: channel,
  });
  return verdict.allowed ? null : verdict.reason ?? "not contactable";
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
}): Promise<StepResult> {
  const { step, context, category, journeyName, runId } = args;
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
      if (category === "marketing") {
        const blocked = await marketingBlocked(context, "email");
        if (blocked) return { status: "skipped", note: `Marketing email skipped: ${blocked}` };
      }
      const to = emailAddress(context);
      if (!to) return { status: "skipped", note: "Email skipped: no email address" };

      let subject = stringConfig(step, "subject") ?? "Message from Denago Cape Town";
      let text = stringConfig(step, "body") ?? "";
      let html = stringConfig(step, "htmlBody");
      const templateId = stringConfig(step, "emailTemplateId");
      if (templateId) {
        const template = await prisma.emailTemplate.findUnique({ where: { id: templateId } });
        if (!template) return { status: "skipped", note: "Email skipped: template was deleted" };
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
      if (category === "marketing") {
        const blocked = await marketingBlocked(context, "sms");
        if (blocked) return { status: "skipped", note: `Marketing SMS skipped: ${blocked}` };
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
      await prisma.activity.create({
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
      return { status: "completed", note: `Activity created for ${dueDays} day(s)` };
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
      const max = await prisma.lead.aggregate({ where: { stageId }, _max: { position: true } });
      await prisma.lead.update({
        where: { id: leadId },
        data: { stageId, position: (max._max.position ?? 0) + 1 },
      });
      await emitJourneyEvent({
        type: "stage_entered",
        entityType: "lead",
        entityId: leadId,
        payload: { stageId, sourceRunId: runId, sourceStepId: step.id },
        dedupeKey: `journey-stage:${runId}:${step.id}:${stageId}`,
      });
      return { status: "completed", note: "Lead moved to configured stage" };
    }

    case "assign_user": {
      if (!leadId) return { status: "skipped", note: "Assignment skipped: no lead" };
      const userId = stringConfig(step, "userId");
      if (!userId) return { status: "skipped", note: "Assignment skipped: no user configured" };
      await prisma.lead.update({ where: { id: leadId }, data: { assignedToId: userId } });
      return { status: "completed", note: "Lead assigned" };
    }

    case "add_tag":
    case "remove_tag": {
      if (!contactId) return { status: "skipped", note: "Tag step skipped: no contact" };
      const tagId = stringConfig(step, "tagId");
      if (!tagId) return { status: "skipped", note: "Tag step skipped: no tag configured" };
      // The _ContactToTag join table carries no tenantId and has no RLS policy, so a
      // raw write to it is NOT tenant-checked by the DB. Prove BOTH ends belong to the
      // current tenant through the scoped client first (RLS returns null for a row
      // outside the tenant under enforcement) — a journey step configured with another
      // tenant's tag id must never create or delete a cross-tenant link.
      const [contactOwned, tagOwned] = await Promise.all([
        prisma.contact.findUnique({ where: { id: contactId }, select: { id: true } }),
        prisma.tag.findUnique({ where: { id: tagId }, select: { id: true } }),
      ]);
      if (!contactOwned || !tagOwned) {
        return { status: "skipped", note: "Tag step skipped: contact or tag not in this tenant" };
      }
      if (step.type === "add_tag") {
        await basePrisma.$executeRaw`INSERT INTO "_ContactToTag" ("A", "B") VALUES (${contactId}, ${tagId}) ON CONFLICT DO NOTHING`;
      } else {
        await basePrisma.$executeRaw`DELETE FROM "_ContactToTag" WHERE "A" = ${contactId} AND "B" = ${tagId}`;
      }
      return { status: "completed", note: step.type === "add_tag" ? "Tag added" : "Tag removed" };
    }
  }

  await logAudit({
    action: "journey.unknown_step",
    summary: `Unknown journey step ${step.type}`,
    leadId,
    contactId,
    userName: "Journey engine",
  });
  return { status: "skipped", note: `Unknown step ${step.type}` };
}
