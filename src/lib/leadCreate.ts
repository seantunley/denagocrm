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
 * `externalId` is a durable creation identity, not merely metadata. This helper
 * deliberately sees soft-deleted rows through basePrisma: deleting the first
 * result is a user decision, not permission for a webhook retry to recreate it.
 * The explicit tenant filter prevents a trusted read from crossing workspaces.
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
    // Never write a tenant-owned Lead tenantless. The db.ts guard only stamps
    // tenantId under enforcement, which is dormant, so without this the row lands
    // NULL while existingExternalLead() looks it up by DEFAULT_TENANT_ID — the
    // retry pre-check could never match the very rows it exists to find.
    tenantId: writeTenantId() ?? DEFAULT_TENANT_ID,
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
    // The pre-check handles provider retries; the unique externalId constraint is
    // the concurrency backstop if two first attempts race. Returning the winner
    // is important: audit, push and lead_created were already owed by that first
    // successful creation and must not be emitted twice here.
    if (input.externalId && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await existingExternalLead(input.externalId);
      if (winner) return winner;
      // The constraint is @@unique([tenantId, externalId]) — the same domain this
      // lookup uses — so a P2002 means the winner is this tenant's and the read
      // above should have found it. Reaching here means the two have drifted apart
      // again; say so rather than replaying a bare P2002 for ever.
      throw new Error(
        `Lead externalId ${input.externalId} collided within this tenant but no existing row could be read back; the unique constraint and existingExternalLead() no longer agree.`,
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
