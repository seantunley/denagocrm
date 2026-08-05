import { addDays, addHours, addMinutes } from "date-fns";
import { prisma, basePrisma } from "./db";
import { nextStepDueDate } from "./businessHours";
import { getNextStepScheduling } from "./nextStepConfig";
import { resolveTenantActor } from "./tenantActor";
import { sendEmail, renderTemplate } from "./email";
import { sendSms } from "./sms";
import { sendPushToAll } from "./push";
import { logAudit } from "./audit";
import { emitJourneyEvent } from "./journeyEvents";
import { emitLeadJourneyEvent } from "./leadJourneyEvents";
import { markReferralEarned } from "./referrals";
import { canContactPerson, nextCommunicationWindow } from "./communicationPolicy";
import { JourneyContext, journeyTemplateVars } from "./journeyContext";
import { AbortJourney } from "./journeyControlFlow";
import { conditionStepOutcome, stopStepOutcome } from "./journeyStepControl";
import { applyLeadOutcome, cappedLostReason } from "./journeyLeadOutcome";
import { parseLeadOutcomeConfig, type JourneyStep } from "./journeyTypes";

export { resolveTopLevelNext } from "./journeyStepControl";

export type StepResult = {
  status: "completed" | "skipped" | "waiting";
  note: string;
  /**
   * An EXPLICIT jump, set only by the top-level two-way `condition` step.
   *
   * This replaces a `nextStepId?: string | null` that carried three meanings on
   * one field: absent meant "fall through to the step's own nextStepId", `null`
   * meant "there is no successor, end the run", and a string meant "jump here".
   * The `stop` step used the `null` spelling, so "the author asked to stop" and
   * "this branch simply has no successor" were indistinguishable — in the code
   * and in the trace. `stop` now raises StopJourney, and the remaining two cases
   * are told apart by the presence of this object rather than by null-vs-
   * undefined on the same key.
   */
  branch?: { stepId: string | null };
  /**
   * "I could not do this yet — try this SAME step again at nextRunAt."
   *
   * Two different things share `status: "waiting"`. A `wait` step SUCCEEDED —
   * pausing is the whole job — so the run resumes on the step after it. A
   * deferred step did NOT run: quiet hours or a frequency cap held the send,
   * and the message still has to go out.
   *
   * Telling them apart cannot be left to `branch`. `advanceCursor` honours an
   * override at the TOP LEVEL ONLY — inside a repeat or a choose it ignores the
   * override and steps the frame index on regardless — so a marketing email
   * nested in a loop would have been advanced past and silently never sent.
   * That is the same class of failure as the suppressed-marketing-send bug, so
   * it gets its own flag rather than an encoding that works in one place.
   */
  retryStep?: true;
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

/** What to call the lead in an audit summary a person will read months later. */
function leadTitle(context: JourneyContext) {
  const lead = (context.lead ?? {}) as Record<string, unknown>;
  return String(lead.title ?? lead.name ?? "").trim() || "Lead";
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
 *
 * Returns `defer` for a refusal that is about WHEN, not WHETHER. Quiet hours are
 * temporal — the person has not refused anything, it is merely 3am — so a
 * skipped step there silently destroys the message, which is a worse outcome
 * than the 3am send it was added to prevent. The caller waits instead.
 */
type ConsentVerdict =
  | { kind: "allowed" }
  | { kind: "blocked"; reason: string }
  | { kind: "defer"; reason: string; until: Date };

async function marketingVerdict(context: JourneyContext, channel: "email" | "sms"): Promise<ConsentVerdict> {
  const contact = (context.contact ?? {}) as Record<string, unknown>;
  const contactId = typeof contact.id === "string" ? contact.id : null;
  if (!contactId) return { kind: "blocked", reason: "no contact record to check consent against" };

  // Read the tenant from the ROW, not from the journey context. The context is
  // a compacted snapshot (compactContact) that carries no tenantId, so taking
  // it from there yielded null for every contact — and canContactPerson matches
  // with `IS NOT DISTINCT FROM`, so null vs a real tenant is a miss. Every
  // marketing journey email and SMS would have been blocked as
  // "contact_not_found_or_cross_tenant".
  //
  // A stored context is also a SNAPSHOT taken when the run was enqueued; runs
  // wait days between steps, so even once the field is added, an in-flight run
  // would still carry whatever was true then. The row is the only current
  // answer. A contact that has since been deleted resolves to null here and is
  // then refused by the policy, which is the right outcome.
  const row = await prisma.contact.findFirst({
    where: { id: contactId },
    select: { tenantId: true },
  });
  const verdict = await canContactPerson({
    contactId,
    tenantId: row?.tenantId ?? null,
    purpose: "marketing",
    requestedChannel: channel,
  });
  if (verdict.allowed) return { kind: "allowed" };
  if (verdict.reason === "quiet_hours") {
    return { kind: "defer", reason: "quiet hours", until: nextCommunicationWindow(new Date()) };
  }
  return { kind: "blocked", reason: verdict.reason ?? "not contactable" };
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
  /**
   * The RUN's tenant, straight off `JourneyRun.tenantId` — not the journey
   * context, which is a compacted snapshot carrying no tenant at all, and not
   * the ambient scope, which is invisible to a `where` clause while the db.ts
   * guard is dormant.
   *
   * Every write this executor makes to a Lead names it explicitly. Without it
   * `where: { id: leadId }` means "any lead in the database with this id", and a
   * step could close another workspace's deal. See journeyLeadOutcome.ts.
   */
  tenantId: string | null;
  /**
   * True when the step is inside a `choose`/`repeat` sequence. It changes
   * exactly one thing — what a failing `condition` means — because a sequence
   * has no ids to jump to. See the `condition` case.
   */
  inSequence?: boolean;
}): Promise<StepResult> {
  const { step, context, category, journeyName, runId, tenantId, inSequence = false } = args;
  const vars = journeyTemplateVars(context);
  const { leadId, contactId } = ids(context);

  switch (step.type) {
    // Control flow and run state, not action. The RUNNER owns these because
    // executing them means moving the cursor or rewriting the context, and this
    // function is handed neither — see journeyScript.ts and journeyWait.ts.
    // Reaching here at all is a routing bug, and a silent one if it returned a
    // skip: a `variables` step that quietly did nothing would leave every later
    // template rendering blank.
    case "choose":
    case "repeat":
    case "wait_for_trigger":
    case "variables":
      throw new AbortJourney(`${step.type} ${step.id} reached the action executor`);

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

    // Both are PURE decisions, so they live in journeyStepControl.ts where a
    // test can import them without dragging the database, the mail provider and
    // `server-only` along with them.
    case "condition":
      return conditionStepOutcome(step, context, inSequence);

    case "stop":
      return stopStepOutcome(step);

    case "send_email": {
      if (category === "marketing") {
        const verdict = await marketingVerdict(context, "email");
        if (verdict.kind === "defer") {
          return { status: "waiting", note: `Email held for ${verdict.reason}`, nextRunAt: verdict.until, retryStep: true };
        }
        if (verdict.kind === "blocked") return { status: "skipped", note: `Marketing email skipped: ${verdict.reason}` };
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
        const verdict = await marketingVerdict(context, "sms");
        if (verdict.kind === "defer") {
          return { status: "waiting", note: `SMS held for ${verdict.reason}`, nextRunAt: verdict.until, retryStep: true };
        }
        if (verdict.kind === "blocked") return { status: "skipped", note: `Marketing SMS skipped: ${verdict.reason}` };
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
      // Honour the tenant's next-step scheduling (work hour, skip weekends).
      // `addDays(new Date(), dueDays)` was used here, which is what the retired
      // AutomationRule engine deliberately did NOT do: its create_activity went
      // through nextStepDueDate, so "due in 1 day" for a lead that arrived at
      // 23:09 on a Friday meant 09:00 Monday, not 23:09 Saturday. Retiring that
      // engine without this would have silently dropped the setting — and
      // runActivityReminders only pushes for a dueDate still in the future, so a
      // same-day (dueDays: 0) task could also have landed already overdue.
      const dueDate = nextStepDueDate(new Date(), dueDays, await getNextStepScheduling());
      await prisma.activity.create({
        data: {
          type: stringConfig(step, "activityType") ?? "todo",
          summary,
          note: stringConfig(step, "note"),
          dueDate,
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
        url: leadId ? `/leads/${leadId}` : contactId ? `/contacts/${contactId}` : "/journeys",
      });
      return { status: "completed", note: "Team push notification sent" };
    }

    case "move_stage": {
      if (!leadId) return { status: "skipped", note: "Stage move skipped: no lead" };
      const stageId = stringConfig(step, "stageId");
      if (!stageId) return { status: "skipped", note: "Stage move skipped: no stage configured" };
      const max = await prisma.lead.aggregate({ where: { stageId }, _max: { position: true } });
      // Same shape as the lead-outcome steps, and for the same two reasons:
      // `update({ where: { id } })` carried NO tenant predicate while the db.ts
      // guard is dormant, and it threw P2025 — failing the step and burning a
      // run attempt — for a lead deleted while the run was parked. See
      // journeyLeadOutcome.ts for the full argument.
      const moved = await prisma.lead.updateMany({
        where: { id: leadId, tenantId, deletedAt: null },
        data: { stageId, position: (max._max.position ?? 0) + 1 },
      });
      if (moved.count !== 1) {
        return { status: "skipped", note: "Stage move skipped: lead is deleted or not in this workspace" };
      }
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
      const assigned = await prisma.lead.updateMany({
        where: { id: leadId, tenantId, deletedAt: null },
        data: { assignedToId: userId },
      });
      if (assigned.count !== 1) {
        return { status: "skipped", note: "Assignment skipped: lead is deleted or not in this workspace" };
      }
      return { status: "completed", note: "Lead assigned" };
    }

    /**
     * The lead OUTCOME steps — the thing a journey could be TRIGGERED by and
     * could not do: `lead_won` and `lead_lost` were both enrolment triggers,
     * with no step on the other side of them.
     *
     * The row write and its guard live in journeyLeadOutcome.ts (importable, and
     * therefore testable, without the mail provider and `server-only` coming
     * with it). What is here is the fan-out, and every part of it is gated on
     * `outcome.applied` — the count check — so a retry, or a second pass of a
     * `repeat`, cannot earn a referral fee twice or emit a second `lead_won`.
     * That is the same gate `setQuoteStatus` and the signing hub already put in
     * front of their own won-effects, keyed off `won.count === 1`.
     *
     * The fan-out matches those two paths deliberately: referral, journey event,
     * audit. It does NOT create a Contact for a won lead with none, and it does
     * not trigger the "won" survey — `markWon` (the staff action) does both, and
     * neither of the two existing automated win paths does either. Following the
     * automated paths keeps this a third instance of an established behaviour
     * rather than a fourth, differently-shaped one.
     */
    case "lead_mark_won":
    case "lead_mark_lost":
    case "lead_reopen": {
      const config = parseLeadOutcomeConfig(step.type, step.config);
      // Rendered like every other authored string in a journey, then capped
      // against what reaches the column rather than against the template.
      const reason = config.reason ? cappedLostReason(renderTemplate(config.reason, vars)) : null;
      const outcome = await applyLeadOutcome({
        type: step.type,
        leadId,
        tenantId,
        reason,
        updateLead: (updateArgs) => prisma.lead.updateMany(updateArgs),
      });
      if (!outcome.applied) {
        return { status: "skipped", note: outcome.note, output: outcome.output };
      }

      // Won leads earn the referrer's fee. Best-effort and swallowed, exactly as
      // in setQuoteStatus and postComplete: the lead IS won, and a referral
      // bookkeeping failure must not undo that by failing the step.
      if (step.type === "lead_mark_won" && leadId) {
        await markReferralEarned(leadId).catch(() => {});
      }
      // Re-enters the engine, which is the point: a `lead_won` journey should
      // fire whether the win came from a rep, a signed quote, or this step.
      // Terminating, despite the loop it looks like — the run it enrols reaches
      // its own mark-won step, matches nothing (the lead is already won), and
      // emits nothing. The `from` guard is what makes that true.
      if (outcome.event && leadId) {
        await emitLeadJourneyEvent(outcome.event, leadId, {
          payload: { sourceRunId: runId, sourceStepId: step.id },
        });
      }
      await logAudit({
        action: outcome.auditAction,
        summary:
          `Lead “${leadTitle(context)}” ${outcome.verb} by journey “${journeyName}”` +
          (reason ? ` — ${reason}` : ""),
        leadId,
        contactId,
        userName: "Journey engine",
        metadata: { runId, stepId: step.id, journey: journeyName, ...(reason ? { lostReason: reason } : {}) },
      });
      return { status: "completed", note: outcome.note, output: outcome.output };
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
