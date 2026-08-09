import { Prisma } from "@prisma/client";
import { prisma, basePrisma } from "./db";
import { logAudit, logAuditStrict } from "./audit";
import { topPosition } from "./leadPos";
import { sendPushToAll, type PushKind } from "./push";
import { emitLeadJourneyEvent } from "./leadJourneyEvents";
import { DEFAULT_TENANT_ID } from "./tenant";
import { writeTenantId } from "./tenantWrite";

/** The row itself. Everything a source may legitimately vary. */
export type NewLeadFields = {
  title: string;
  name: string;
  source: string;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  color?: string | null;
  productId?: string | null;
  contactId?: string | null;
  assignedToId?: string | null;
  createdById?: string | null;
  quantity?: number;
  valueCents?: number;
  externalId?: string | null;
  raw?: unknown;
  stageId?: string | null;
};

export type LeadAudit = {
  action: string;
  summary: string;
  strict?: boolean;
  user?: { id: string; name: string } | null;
  userName?: string;
  recordAfter?: boolean;
};

export type LeadPush = { title: string; body: string; kind: PushKind };
export type NewLead = NewLeadFields & { audit: LeadAudit; push?: LeadPush | null };

async function resolveStageId(stageId?: string | null): Promise<string | null> {
  if (stageId) return stageId;
  const firstStage = await prisma.pipelineStage.findFirst({ orderBy: { order: "asc" } });
  return firstStage?.id ?? null;
}

/**
 * `externalId` is a durable creation identity, not merely metadata. This read
 * deliberately uses basePrisma so a soft-deleted first result is still visible:
 * deleting a record is a user decision, not permission for a webhook retry to
 * recreate the same business effect. The explicit tenant predicate is mandatory.
 */
async function existingExternalLead(externalId?: string | null) {
  if (!externalId) return null;
  const tenantId = writeTenantId() ?? DEFAULT_TENANT_ID;
  return basePrisma.lead.findFirst({ where: { tenantId, externalId } });
}

async function createInStage(input: NewLead, stageId: string) {
  const alreadyCreated = await existingExternalLead(input.externalId);
  if (alreadyCreated) return alreadyCreated;

  const position = await topPosition(stageId);
  const data = {
    title: input.title,
    name: input.name,
    source: input.source,
    email: input.email ?? null,
    phone: input.phone ?? null,
    notes: input.notes ?? null,
    color: input.color ?? null,
    productId: input.productId ?? null,
    contactId: input.contactId ?? null,
    assignedToId: input.assignedToId ?? null,
    createdById: input.createdById ?? null,
    ...(input.quantity != null ? { quantity: input.quantity } : {}),
    valueCents: input.valueCents ?? 0,
    externalId: input.externalId ?? null,
    raw: input.raw != null ? JSON.stringify(input.raw) : null,
    stageId,
    position,
  };

  const auditFor = (lead: { id: string; contactId: string | null }) => ({
    action: input.audit.action,
    summary: input.audit.summary,
    leadId: lead.id,
    contactId: lead.contactId,
    user: input.audit.user ?? null,
    userName: input.audit.userName,
    ...(input.audit.recordAfter ? { after: lead } : {}),
  });

  let lead;
  try {
    lead = input.audit.strict
      ? await prisma.$transaction(async (tx) => {
          const created = await tx.lead.create({ data });
          await logAuditStrict(auditFor(created), tx);
          return created;
        })
      : await prisma.lead.create({ data });
  } catch (error) {
    // Provider retries are handled by the pre-check. The unique externalId
    // constraint is the race backstop for concurrent first attempts: return the
    // winner instead of creating/auditing/pushing a duplicate effect.
    if (input.externalId && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await existingExternalLead(input.externalId);
      if (winner) return winner;
      // `externalId` is unique across the whole table, but the lookup above is
      // tenant-scoped, so a collision owned by ANOTHER tenant lands here with no
      // winner to return. Retrying can never clear that, and a bare P2002 reads as
      // transient — the webhook would release the event and replay it forever. Say
      // what actually happened instead. (The structural fix is a composite
      // @@unique([tenantId, externalId]), which needs its own migration.)
      throw new Error(
        `Lead externalId ${input.externalId} already belongs to a different tenant — this lead cannot be created here, and retrying will not change that.`,
      );
    }
    throw error;
  }

  if (!input.audit.strict) await logAudit(auditFor(lead));

  const push = input.push === undefined
    ? { title: "New lead 🚀", body: `${lead.title} — ${lead.name} (via ${lead.source})`, kind: "lead_new" as const }
    : input.push;
  if (push) {
    await sendPushToAll({ title: push.title, body: push.body, url: `/leads/${lead.id}` }, push.kind).catch(() => {});
  }

  await emitLeadJourneyEvent("lead_created", lead.id, { payload: { source: lead.source } });
  return lead;
}

export async function createLeadRecord(input: NewLead) {
  const existing = await existingExternalLead(input.externalId);
  if (existing) return existing;
  const stageId = await resolveStageId(input.stageId);
  if (!stageId) throw new Error("No pipeline stages configured");
  return createInStage(input, stageId);
}

export async function createLeadRecordIfPipelineReady(input: NewLead) {
  const existing = await existingExternalLead(input.externalId);
  if (existing) return existing;
  const stageId = await resolveStageId(input.stageId);
  if (!stageId) return null;
  return createInStage(input, stageId);
}
