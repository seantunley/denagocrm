import crypto from "crypto";
import { addHours, differenceInCalendarMonths, subDays } from "date-fns";
import { z } from "zod";
import { basePrisma, prisma } from "./db";
import { leadVars, renderTemplate, sendEmail } from "./email";
import { contactName } from "./format";
import { logAudit } from "./audit";
import { newToken } from "./campaigns";
import { sendPushToAll } from "./push";

export const JOURNEY_TRIGGERS = [
  "lead_created",
  "stage_entered",
  "lead_won",
  "lead_lost",
  "quote_signed",
  "quote_declined",
  "delivered",
  "referral_earned",
  "lead_idle",
  "purchase_anniversary",
  "winback",
] as const;

export type JourneyTrigger = (typeof JOURNEY_TRIGGERS)[number];

const conditionSchema = z.object({
  field: z.string().min(1),
  operator: z.enum(["eq", "neq", "contains", "gt", "gte", "lt", "lte", "empty", "not_empty", "in"]),
  value: z.unknown().optional(),
});

const conditionGroupSchema: z.ZodType<ConditionGroup> = z.lazy(() =>
  z.object({
    mode: z.enum(["and", "or"]).default("and"),
    conditions: z.array(z.union([conditionSchema, conditionGroupSchema])).default([]),
  })
);

const journeyStepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("wait"), hours: z.number().min(0.25).max(8760) }),
  z.object({
    type: z.literal("condition"),
    conditions: conditionGroupSchema,
    onTrue: z.number().int().min(0),
    onFalse: z.number().int().min(0),
  }),
  z.object({
    type: z.literal("send_campaign"),
    campaignId: z.string().min(1),
  }),
  z.object({
    type: z.literal("send_email"),
    subject: z.string().min(1),
    body: z.string().min(1),
    transactional: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("create_activity"),
    activityType: z.enum(["call", "email", "meeting", "whatsapp", "todo"]).default("todo"),
    summary: z.string().min(1),
    dueHours: z.number().min(0).max(8760).default(24),
    assignToId: z.string().nullable().optional(),
  }),
  z.object({ type: z.literal("move_stage"), stageId: z.string().min(1) }),
  z.object({ type: z.literal("assign_user"), userId: z.string().min(1) }),
  z.object({ type: z.literal("add_tag"), tagId: z.string().min(1) }),
  z.object({ type: z.literal("remove_tag"), tagId: z.string().min(1) }),
  z.object({ type: z.literal("send_push"), title: z.string().min(1), body: z.string().min(1) }),
  z.object({ type: z.literal("end"), reason: z.string().optional() }),
]);

export const journeyDefinitionSchema = z.object({
  entryConditions: conditionGroupSchema.optional(),
  idleDays: z.number().int().min(1).max(3650).optional(),
  steps: z.array(journeyStepSchema).min(1).max(100),
});

export type Condition = z.infer<typeof conditionSchema>;
export type ConditionGroup = { mode: "and" | "or"; conditions: Array<Condition | ConditionGroup> };
export type JourneyDefinition = z.infer<typeof journeyDefinitionSchema>;
export type JourneyStep = JourneyDefinition["steps"][number];

export type JourneyRow = {
  id: string;
  name: string;
  description: string | null;
  category: string;
  trigger: JourneyTrigger;
  active: boolean;
  stopOnReply: boolean;
  respectMarketingConsent: boolean;
  frequencyCapHours: number;
  currentDraftVersionId: string | null;
  publishedVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type JourneyVersionRow = {
  id: string;
  journeyId: string;
  version: number;
  status: "draft" | "published" | "archived";
  definition: JourneyDefinition;
  notes: string | null;
  createdAt: Date;
  publishedAt: Date | null;
};

type EnrollmentRow = {
  id: string;
  journeyId: string;
  versionId: string;
  leadId: string | null;
  contactId: string | null;
  status: string;
  currentStep: number;
  wakeAt: Date;
  startedAt: Date;
  completedAt: Date | null;
  stoppedReason: string | null;
  lastMessageAt: Date | null;
  state: Record<string, unknown>;
  journeyName: string;
  stopOnReply: boolean;
  respectMarketingConsent: boolean;
  frequencyCapHours: number;
  definition: JourneyDefinition;
};

type Subject = {
  lead: Awaited<ReturnType<typeof loadLead>>;
  contact: Awaited<ReturnType<typeof loadContact>>;
  event: Record<string, unknown>;
};

const id = () => crypto.randomUUID();

function isGroup(value: Condition | ConditionGroup): value is ConditionGroup {
  return "conditions" in value;
}

function valueAtPath(subject: Subject, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (value && typeof value === "object") return (value as Record<string, unknown>)[key];
    return undefined;
  }, subject);
}

function compare(actual: unknown, condition: Condition): boolean {
  const expected = condition.value;
  switch (condition.operator) {
    case "eq": return String(actual ?? "") === String(expected ?? "");
    case "neq": return String(actual ?? "") !== String(expected ?? "");
    case "contains": return String(actual ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
    case "gt": return Number(actual) > Number(expected);
    case "gte": return Number(actual) >= Number(expected);
    case "lt": return Number(actual) < Number(expected);
    case "lte": return Number(actual) <= Number(expected);
    case "empty": return actual == null || actual === "" || (Array.isArray(actual) && actual.length === 0);
    case "not_empty": return !(actual == null || actual === "" || (Array.isArray(actual) && actual.length === 0));
    case "in": return Array.isArray(expected) && expected.map(String).includes(String(actual ?? ""));
  }
}

export function conditionsHold(group: ConditionGroup | undefined, subject: Subject): boolean {
  if (!group || group.conditions.length === 0) return true;
  const results = group.conditions.map((item) =>
    isGroup(item) ? conditionsHold(item, subject) : compare(valueAtPath(subject, item.field), item)
  );
  return group.mode === "or" ? results.some(Boolean) : results.every(Boolean);
}

async function loadLead(leadId: string | null) {
  if (!leadId) return null;
  return prisma.lead.findUnique({
    where: { id: leadId },
    include: { product: true, assignedTo: true, stage: true, contact: true },
  });
}

async function loadContact(contactId: string | null) {
  if (!contactId) return null;
  return prisma.contact.findUnique({
    where: { id: contactId },
    include: { tags: true, vehicles: { include: { serviceRecords: true, mileageLogs: true } } },
  });
}

async function loadSubject(leadId: string | null, contactId: string | null, event: Record<string, unknown> = {}): Promise<Subject> {
  const lead = await loadLead(leadId);
  const resolvedContactId = contactId ?? lead?.contactId ?? null;
  const contact = await loadContact(resolvedContactId);
  return { lead, contact, event };
}

function templateVars(subject: Subject): Record<string, string> {
  if (subject.lead) {
    const vars = leadVars(subject.lead);
    return {
      ...vars,
      first_name: subject.contact?.firstName ?? subject.lead.name.split(" ")[0] ?? subject.lead.name,
      contact_name: subject.contact ? contactName(subject.contact) : subject.lead.name,
    };
  }
  const contact = subject.contact;
  return {
    name: contact ? contactName(contact) : "Customer",
    first_name: contact?.firstName ?? "Customer",
    contact_name: contact ? contactName(contact) : "Customer",
    company: contact?.company ?? "",
    email: contact?.email ?? "",
    phone: contact?.phone ?? "",
  };
}

async function fallbackUserId(subject: Subject, preferred?: string | null) {
  if (preferred) return preferred;
  if (subject.lead?.assignedToId) return subject.lead.assignedToId;
  if (subject.contact?.ownerId) return subject.contact.ownerId;
  const first = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!first) throw new Error("No users exist");
  return first.id;
}

export async function listJourneys(): Promise<JourneyRow[]> {
  return basePrisma.$queryRaw<JourneyRow[]>`
    SELECT * FROM "MarketingJourney"
    WHERE "deletedAt" IS NULL
    ORDER BY "createdAt" DESC
  `;
}

export async function getJourney(idValue: string): Promise<{ journey: JourneyRow; versions: JourneyVersionRow[] } | null> {
  const journeys = await basePrisma.$queryRaw<JourneyRow[]>`
    SELECT * FROM "MarketingJourney" WHERE "id" = ${idValue} AND "deletedAt" IS NULL LIMIT 1
  `;
  if (!journeys[0]) return null;
  const versions = await basePrisma.$queryRaw<JourneyVersionRow[]>`
    SELECT * FROM "MarketingJourneyVersion" WHERE "journeyId" = ${idValue} ORDER BY "version" DESC
  `;
  return { journey: journeys[0], versions };
}

export async function createJourney(input: {
  name: string;
  description?: string | null;
  category?: string;
  trigger: JourneyTrigger;
  definition: JourneyDefinition;
  createdById?: string | null;
  stopOnReply?: boolean;
  respectMarketingConsent?: boolean;
  frequencyCapHours?: number;
}) {
  const definition = journeyDefinitionSchema.parse(input.definition);
  const journeyId = id();
  const versionId = id();
  await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO "MarketingJourney" (
        "id", "name", "description", "category", "trigger", "active", "stopOnReply",
        "respectMarketingConsent", "frequencyCapHours", "currentDraftVersionId", "createdById"
      ) VALUES (
        ${journeyId}, ${input.name}, ${input.description ?? null}, ${input.category ?? "marketing"},
        ${input.trigger}, false, ${input.stopOnReply ?? true}, ${input.respectMarketingConsent ?? true},
        ${input.frequencyCapHours ?? 24}, ${versionId}, ${input.createdById ?? null}
      )
    `;
    await tx.$executeRaw`
      INSERT INTO "MarketingJourneyVersion" (
        "id", "journeyId", "version", "status", "definition", "createdById"
      ) VALUES (${versionId}, ${journeyId}, 1, 'draft', ${JSON.stringify(definition)}::jsonb, ${input.createdById ?? null})
    `;
  });
  return journeyId;
}

export async function saveJourneyDraft(journeyId: string, input: {
  name: string;
  description?: string | null;
  trigger: JourneyTrigger;
  definition: JourneyDefinition;
  stopOnReply: boolean;
  respectMarketingConsent: boolean;
  frequencyCapHours: number;
  userId?: string | null;
}) {
  const definition = journeyDefinitionSchema.parse(input.definition);
  const rows = await basePrisma.$queryRaw<Array<{ currentDraftVersionId: string | null; maxVersion: number }>>`
    SELECT j."currentDraftVersionId", COALESCE(MAX(v."version"), 0)::int AS "maxVersion"
    FROM "MarketingJourney" j
    LEFT JOIN "MarketingJourneyVersion" v ON v."journeyId" = j."id"
    WHERE j."id" = ${journeyId}
    GROUP BY j."currentDraftVersionId"
  `;
  if (!rows[0]) throw new Error("Journey not found");
  let draftId = rows[0].currentDraftVersionId;
  await basePrisma.$transaction(async (tx) => {
    if (draftId) {
      const status = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT "status" FROM "MarketingJourneyVersion" WHERE "id" = ${draftId} LIMIT 1
      `;
      if (status[0]?.status === "draft") {
        await tx.$executeRaw`
          UPDATE "MarketingJourneyVersion" SET "definition" = ${JSON.stringify(definition)}::jsonb
          WHERE "id" = ${draftId}
        `;
      } else {
        draftId = null;
      }
    }
    if (!draftId) {
      draftId = id();
      await tx.$executeRaw`
        INSERT INTO "MarketingJourneyVersion" ("id", "journeyId", "version", "status", "definition", "createdById")
        VALUES (${draftId}, ${journeyId}, ${rows[0].maxVersion + 1}, 'draft', ${JSON.stringify(definition)}::jsonb, ${input.userId ?? null})
      `;
    }
    await tx.$executeRaw`
      UPDATE "MarketingJourney"
      SET "name" = ${input.name}, "description" = ${input.description ?? null}, "trigger" = ${input.trigger},
          "stopOnReply" = ${input.stopOnReply}, "respectMarketingConsent" = ${input.respectMarketingConsent},
          "frequencyCapHours" = ${input.frequencyCapHours}, "currentDraftVersionId" = ${draftId}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${journeyId}
    `;
  });
}

export async function publishJourney(journeyId: string) {
  await basePrisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ currentDraftVersionId: string | null }>>`
      SELECT "currentDraftVersionId" FROM "MarketingJourney" WHERE "id" = ${journeyId} FOR UPDATE
    `;
    const draftId = rows[0]?.currentDraftVersionId;
    if (!draftId) throw new Error("Journey has no draft to publish");
    await tx.$executeRaw`
      UPDATE "MarketingJourneyVersion" SET "status" = 'archived'
      WHERE "journeyId" = ${journeyId} AND "status" = 'published'
    `;
    await tx.$executeRaw`
      UPDATE "MarketingJourneyVersion" SET "status" = 'published', "publishedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${draftId} AND "status" = 'draft'
    `;
    await tx.$executeRaw`
      UPDATE "MarketingJourney"
      SET "publishedVersionId" = ${draftId}, "currentDraftVersionId" = NULL, "active" = true, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${journeyId}
    `;
  });
}

export async function toggleJourney(journeyId: string) {
  await basePrisma.$executeRaw`
    UPDATE "MarketingJourney" SET "active" = NOT "active", "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${journeyId} AND "publishedVersionId" IS NOT NULL
  `;
}

export async function archiveJourney(journeyId: string) {
  await basePrisma.$executeRaw`
    UPDATE "MarketingJourney" SET "active" = false, "deletedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${journeyId}
  `;
  await basePrisma.$executeRaw`
    UPDATE "MarketingJourneyEnrollment" SET "status" = 'stopped', "completedAt" = CURRENT_TIMESTAMP,
      "stoppedReason" = 'journey archived', "updatedAt" = CURRENT_TIMESTAMP
    WHERE "journeyId" = ${journeyId} AND "status" IN ('active', 'waiting')
  `;
}

async function consentAllowed(journey: Pick<JourneyRow, "respectMarketingConsent">, subject: Subject) {
  if (!journey.respectMarketingConsent) return true;
  if (!subject.contact) return false;
  if (subject.contact.marketingOptOut) return false;
  const latest = await prisma.consentRecord.findFirst({
    where: { contactId: subject.contact.id, type: "marketing" },
    orderBy: { createdAt: "desc" },
  });
  return latest ? latest.granted : true;
}

export async function enrollJourneysForEvent(
  trigger: JourneyTrigger,
  input: { leadId?: string | null; contactId?: string | null; event?: Record<string, unknown> }
): Promise<number> {
  const journeys = await basePrisma.$queryRaw<Array<JourneyRow & { definition: JourneyDefinition }>>`
    SELECT j.*, v."definition"
    FROM "MarketingJourney" j
    JOIN "MarketingJourneyVersion" v ON v."id" = j."publishedVersionId"
    WHERE j."active" = true AND j."deletedAt" IS NULL AND j."trigger" = ${trigger}
  `;
  if (journeys.length === 0) return 0;
  const subject = await loadSubject(input.leadId ?? null, input.contactId ?? null, input.event ?? {});
  let enrolled = 0;
  for (const journey of journeys) {
    const definition = journeyDefinitionSchema.parse(journey.definition);
    if (!(await consentAllowed(journey, subject))) continue;
    if (!conditionsHold(definition.entryConditions, subject)) continue;
    const enrollmentId = id();
    const inserted = await basePrisma.$executeRaw`
      INSERT INTO "MarketingJourneyEnrollment" (
        "id", "journeyId", "versionId", "leadId", "contactId", "status", "currentStep", "wakeAt", "state"
      ) VALUES (
        ${enrollmentId}, ${journey.id}, ${journey.publishedVersionId!}, ${input.leadId ?? null},
        ${input.contactId ?? subject.contact?.id ?? null}, 'active', 0, CURRENT_TIMESTAMP,
        ${JSON.stringify({ event: input.event ?? {} })}::jsonb
      ) ON CONFLICT DO NOTHING
    `;
    enrolled += inserted;
  }
  return enrolled;
}

async function stopEnrollment(enrollmentId: string, reason: string, status = "stopped") {
  await basePrisma.$executeRaw`
    UPDATE "MarketingJourneyEnrollment"
    SET "status" = ${status}, "stoppedReason" = ${reason}, "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${enrollmentId}
  `;
}

async function hasReply(enrollment: EnrollmentRow) {
  if (!enrollment.stopOnReply || !enrollment.lastMessageAt) return false;
  const hit = await prisma.communication.findFirst({
    where: {
      direction: "inbound",
      occurredAt: { gt: enrollment.lastMessageAt },
      OR: [
        ...(enrollment.leadId ? [{ leadId: enrollment.leadId }] : []),
        ...(enrollment.contactId ? [{ contactId: enrollment.contactId }] : []),
      ],
    },
  });
  return Boolean(hit);
}

async function frequencyCapped(enrollment: EnrollmentRow, contactId: string | null) {
  if (!contactId || enrollment.frequencyCapHours <= 0) return false;
  const hit = await prisma.communication.findFirst({
    where: {
      contactId,
      direction: "outbound",
      type: { in: ["email", "whatsapp"] },
      occurredAt: { gte: addHours(new Date(), -enrollment.frequencyCapHours) },
    },
  });
  return Boolean(hit);
}

async function logStep(enrollmentId: string, stepIndex: number, stepType: string, fn: () => Promise<Record<string, unknown>>) {
  const runId = id();
  await basePrisma.$executeRaw`
    INSERT INTO "MarketingJourneyStepRun" ("id", "enrollmentId", "stepIndex", "stepType", "status")
    VALUES (${runId}, ${enrollmentId}, ${stepIndex}, ${stepType}, 'running')
  `;
  try {
    const output = await fn();
    await basePrisma.$executeRaw`
      UPDATE "MarketingJourneyStepRun" SET "status" = 'completed', "output" = ${JSON.stringify(output)}::jsonb,
        "completedAt" = CURRENT_TIMESTAMP WHERE "id" = ${runId}
    `;
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown journey step error";
    await basePrisma.$executeRaw`
      UPDATE "MarketingJourneyStepRun" SET "status" = 'failed', "error" = ${message.slice(0, 1000)},
        "completedAt" = CURRENT_TIMESTAMP WHERE "id" = ${runId}
    `;
    throw error;
  }
}

async function executeStep(enrollment: EnrollmentRow, step: JourneyStep, subject: Subject): Promise<{ next: number; waitUntil?: Date; end?: string; messageAt?: Date }> {
  const vars = templateVars(subject);
  const next = enrollment.currentStep + 1;
  switch (step.type) {
    case "wait":
      return { next, waitUntil: addHours(new Date(), step.hours) };
    case "condition":
      return { next: conditionsHold(step.conditions, subject) ? step.onTrue : step.onFalse };
    case "send_campaign": {
      if (!subject.contact) throw new Error("Campaign steps require a linked contact");
      if (subject.contact.marketingOptOut) return { next, end: "marketing opt-out" };
      if (await frequencyCapped(enrollment, subject.contact.id)) {
        return { next: enrollment.currentStep, waitUntil: addHours(new Date(), enrollment.frequencyCapHours) };
      }
      const campaign = await prisma.campaign.findUnique({ where: { id: step.campaignId } });
      if (!campaign) throw new Error("Selected campaign no longer exists");
      const existing = await prisma.campaignRecipient.findFirst({
        where: { campaignId: campaign.id, contactId: subject.contact.id },
      });
      if (!existing) {
        await prisma.campaignRecipient.create({
          data: { campaignId: campaign.id, contactId: subject.contact.id, token: newToken(), status: "queued" },
        });
        await prisma.campaign.update({
          where: { id: campaign.id },
          data: { status: "queued", recipientCount: { increment: 1 } },
        });
      }
      return { next, messageAt: new Date() };
    }
    case "send_email": {
      const to = subject.contact?.email ?? subject.lead?.email;
      if (!to) return { next };
      if (!step.transactional && subject.contact?.marketingOptOut) return { next, end: "marketing opt-out" };
      const subjectLine = renderTemplate(step.subject, vars);
      const body = renderTemplate(step.body, vars);
      const result = await sendEmail({ to, subject: subjectLine, text: body });
      if (!result.ok) throw new Error(result.error ?? "Email send failed");
      const userId = await fallbackUserId(subject);
      await prisma.communication.create({
        data: {
          type: "email",
          direction: "outbound",
          subject: subjectLine,
          body: `[Journey: ${enrollment.journeyName}]\n\n${body}`,
          leadId: enrollment.leadId,
          contactId: enrollment.contactId ?? subject.contact?.id,
          userId,
        },
      });
      return { next, messageAt: new Date() };
    }
    case "create_activity": {
      const userId = await fallbackUserId(subject, step.assignToId);
      await prisma.activity.create({
        data: {
          type: step.activityType,
          summary: renderTemplate(step.summary, vars),
          dueDate: addHours(new Date(), step.dueHours),
          leadId: enrollment.leadId,
          contactId: enrollment.contactId ?? subject.contact?.id,
          assignedToId: userId,
          createdById: userId,
        },
      });
      return { next };
    }
    case "move_stage": {
      if (!subject.lead) return { next };
      const max = await prisma.lead.aggregate({ where: { stageId: step.stageId }, _max: { position: true } });
      await prisma.lead.update({
        where: { id: subject.lead.id },
        data: { stageId: step.stageId, position: (max._max.position ?? 0) + 1 },
      });
      return { next };
    }
    case "assign_user":
      if (subject.lead) await prisma.lead.update({ where: { id: subject.lead.id }, data: { assignedToId: step.userId } });
      else if (subject.contact) await prisma.contact.update({ where: { id: subject.contact.id }, data: { ownerId: step.userId } });
      return { next };
    case "add_tag":
      if (subject.contact) await prisma.contact.update({ where: { id: subject.contact.id }, data: { tags: { connect: { id: step.tagId } } } });
      return { next };
    case "remove_tag":
      if (subject.contact) await prisma.contact.update({ where: { id: subject.contact.id }, data: { tags: { disconnect: { id: step.tagId } } } });
      return { next };
    case "send_push":
      await sendPushToAll({
        title: renderTemplate(step.title, vars),
        body: renderTemplate(step.body, vars),
        url: subject.lead ? `/leads/${subject.lead.id}` : subject.contact ? `/contacts/${subject.contact.id}` : "/automations",
      });
      return { next };
    case "end":
      return { next, end: step.reason ?? "journey completed" };
  }
}

async function processEnrollment(enrollment: EnrollmentRow): Promise<number> {
  const definition = journeyDefinitionSchema.parse(enrollment.definition);
  const event = (enrollment.state?.event as Record<string, unknown> | undefined) ?? {};
  const subject = await loadSubject(enrollment.leadId, enrollment.contactId, event);
  if (!subject.lead && !subject.contact) {
    await stopEnrollment(enrollment.id, "subject deleted");
    return 1;
  }
  if (!(await consentAllowed(enrollment, subject))) {
    await stopEnrollment(enrollment.id, "marketing consent unavailable");
    return 1;
  }
  if (await hasReply(enrollment)) {
    await stopEnrollment(enrollment.id, "customer replied");
    return 1;
  }

  let current = enrollment.currentStep;
  let processed = 0;
  while (processed < 10) {
    const step = definition.steps[current];
    if (!step) {
      await stopEnrollment(enrollment.id, "journey completed", "completed");
      return processed + 1;
    }
    const result = await logStep(enrollment.id, current, step.type, () => executeStep({ ...enrollment, currentStep: current }, step, subject));
    processed++;
    if (result.end) {
      const completed = result.end === "journey completed";
      await stopEnrollment(enrollment.id, result.end, completed ? "completed" : "stopped");
      return processed;
    }
    if (result.waitUntil) {
      await basePrisma.$executeRaw`
        UPDATE "MarketingJourneyEnrollment"
        SET "status" = 'waiting', "currentStep" = ${result.next}, "wakeAt" = ${result.waitUntil},
            "lastMessageAt" = COALESCE(${result.messageAt ?? null}, "lastMessageAt"), "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${enrollment.id}
      `;
      return processed;
    }
    current = result.next;
    await basePrisma.$executeRaw`
      UPDATE "MarketingJourneyEnrollment"
      SET "status" = 'active', "currentStep" = ${current}, "wakeAt" = CURRENT_TIMESTAMP,
          "lastMessageAt" = COALESCE(${result.messageAt ?? null}, "lastMessageAt"), "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${enrollment.id}
    `;
  }
  return processed;
}

async function enrollScheduledJourneys(now: Date) {
  let enrolled = 0;
  const anniversaryCount = await basePrisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) AS count FROM "MarketingJourney"
    WHERE "active" = true AND "deletedAt" IS NULL AND "trigger" = 'purchase_anniversary'
  `;
  if (Number(anniversaryCount[0]?.count ?? 0) > 0) {
    const vehicles = await prisma.vehicle.findMany({ where: { purchaseDate: { not: null } }, include: { contact: true } });
    for (const vehicle of vehicles) {
      const purchase = vehicle.purchaseDate!;
      if (purchase.getMonth() !== now.getMonth() || purchase.getDate() !== now.getDate()) continue;
      const years = now.getFullYear() - purchase.getFullYear();
      if (years < 1) continue;
      enrolled += await enrollJourneysForEvent("purchase_anniversary", {
        contactId: vehicle.contactId,
        event: { years, vehicleId: vehicle.id, vehicleModel: vehicle.model },
      });
    }
  }

  const winbackCount = await basePrisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) AS count FROM "MarketingJourney"
    WHERE "active" = true AND "deletedAt" IS NULL AND "trigger" = 'winback'
  `;
  if (Number(winbackCount[0]?.count ?? 0) > 0) {
    const vehicles = await prisma.vehicle.findMany({
      include: {
        contact: { include: { communications: { orderBy: { occurredAt: "desc" }, take: 1 } } },
        serviceRecords: { orderBy: { serviceDate: "desc" }, take: 1 },
      },
    });
    const done = new Set<string>();
    for (const vehicle of vehicles) {
      const contact = vehicle.contact;
      if (done.has(contact.id) || contact.marketingOptOut) continue;
      const baseline = vehicle.serviceRecords[0]?.serviceDate ?? vehicle.purchaseDate;
      if (!baseline || differenceInCalendarMonths(now, baseline) < 12) continue;
      const lastContact = contact.communications[0]?.occurredAt;
      if (lastContact && differenceInCalendarMonths(now, lastContact) < 3) continue;
      done.add(contact.id);
      enrolled += await enrollJourneysForEvent("winback", {
        contactId: contact.id,
        event: { vehicleId: vehicle.id, vehicleModel: vehicle.model },
      });
    }
  }

  const idleJourneys = await basePrisma.$queryRaw<Array<JourneyRow & { definition: JourneyDefinition }>>`
    SELECT j.*, v."definition" FROM "MarketingJourney" j
    JOIN "MarketingJourneyVersion" v ON v."id" = j."publishedVersionId"
    WHERE j."active" = true AND j."deletedAt" IS NULL AND j."trigger" = 'lead_idle'
  `;
  for (const journey of idleJourneys) {
    const definition = journeyDefinitionSchema.parse(journey.definition);
    const idleDays = definition.idleDays ?? 3;
    const leads = await prisma.lead.findMany({ where: { status: "open", updatedAt: { lt: subDays(now, idleDays) } } });
    for (const lead of leads) {
      enrolled += await enrollJourneysForEvent("lead_idle", { leadId: lead.id, contactId: lead.contactId, event: { idleDays } });
    }
  }
  return enrolled;
}

export async function runMarketingJourneyQueue(limit = 100): Promise<{ enrolled: number; processed: number; failed: number }> {
  const enrolled = await enrollScheduledJourneys(new Date());
  const due = await basePrisma.$queryRaw<EnrollmentRow[]>`
    SELECT e.*, j."name" AS "journeyName", j."stopOnReply", j."respectMarketingConsent",
      j."frequencyCapHours", v."definition"
    FROM "MarketingJourneyEnrollment" e
    JOIN "MarketingJourney" j ON j."id" = e."journeyId"
    JOIN "MarketingJourneyVersion" v ON v."id" = e."versionId"
    WHERE e."status" IN ('active', 'waiting') AND e."wakeAt" <= CURRENT_TIMESTAMP
      AND j."active" = true AND j."deletedAt" IS NULL
    ORDER BY e."wakeAt" ASC
    LIMIT ${limit}
  `;
  let processed = 0;
  let failed = 0;
  for (const enrollment of due) {
    try {
      processed += await processEnrollment(enrollment);
      await logAudit({
        action: "journey.processed",
        summary: `Journey “${enrollment.journeyName}” processed`,
        leadId: enrollment.leadId,
        contactId: enrollment.contactId,
        userName: "Automation",
      });
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : "Unknown journey error";
      await stopEnrollment(enrollment.id, `error: ${message}`);
    }
  }
  return { enrolled, processed, failed };
}

export async function getJourneyRunSummary() {
  const rows = await basePrisma.$queryRaw<Array<{ status: string; count: bigint }>>`
    SELECT "status", COUNT(*) AS count FROM "MarketingJourneyEnrollment" GROUP BY "status"
  `;
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}
