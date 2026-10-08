import { Prisma } from "@prisma/client";
import { prisma, basePrisma } from "./db";
import { logAudit, logAuditStrict } from "./audit";
import { topPosition } from "./leadPos";
import { sendPushToAll, type PushKind } from "./push";
import { emitLeadJourneyEvent } from "./leadJourneyEvents";
import { ownedWriteTenantId } from "./tenantWrite";
import {
  LEAD_ROUTING_KEY,
  LEAD_ROUTING_LAST_KEY,
  parseLeadRoutingConfig,
  pickLeadAssignee,
  routingCandidateIds,
} from "./leadRouting";

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
  const tenantId = ownedWriteTenantId();
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
    // Never write a tenant-owned Lead tenantless. The guard only stamps under
    // enforcement, which is still dormant, so without this a new Lead lands with a
    // NULL tenantId while existingExternalLead() looks it up by DEFAULT_TENANT_ID —
    // the retry pre-check could never match the very rows it exists to find. Under
    // enforcement stampCreate overwrites this with the request's scope.
    tenantId: ownedWriteTenantId(),
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
      // The constraint is now @@unique([tenantId, externalId]), the same domain this
      // lookup uses, so a P2002 here means the winner is this tenant's and the read
      // above should have found it. Reaching this line means the two have drifted
      // apart again — say so rather than replaying a bare P2002 for ever.
      throw new Error(
        `Lead externalId ${input.externalId} collided within this tenant but no existing row could be read back; the unique constraint and existingExternalLead() no longer agree.`,
      );
    }
    throw error;
  }

  // Routing runs only for leads nobody chose an owner for AND no person created:
  // every inbound channel (intake API, Meta webhook + sync, DM ads, chatbot)
  // arrives here like that, while a staff-created lead always carries both. One
  // check here instead of one per channel, so a new channel is routed by default.
  if (!input.assignedToId && !input.createdById) lead = await routeInboundLead(lead);

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

type CreatedLead = Awaited<ReturnType<typeof prisma.lead.create>>;

/**
 * Applies the workspace's lead routing (Settings → Lead routing) to a freshly
 * created, unowned inbound lead. Returns the lead as it now stands.
 *
 * The workspace is the LEAD's own tenantId — never the founding one, never the
 * ambient default — and every candidate is re-checked as an active member of
 * exactly that workspace at assignment time, so a rule naming a rep who has
 * since left or been disabled cannot hand them the lead.
 *
 * CONCURRENCY: two leads arriving together must not both read the same pointer
 * and land on the same rep. The pointer read, the pick, the assignment and the
 * pointer write are ONE transaction behind a per-workspace advisory lock (an
 * advisory lock, not a row lock, because the pointer row may not exist yet).
 * Assigning inside that transaction, rather than before the lead is created,
 * also means a create that fails can never advance the pointer and skip a rep.
 *
 * Best-effort by design: the lead already exists, so a routing failure leaves
 * it unassigned (today's behaviour) and is logged — it must never lose the lead.
 */
async function routeInboundLead(lead: CreatedLead): Promise<CreatedLead> {
  const tenantId = lead.tenantId;
  if (!tenantId) return lead;
  try {
    const configRow = await basePrisma.appSetting.findUnique({
      where: { tenantId_key: { tenantId, key: LEAD_ROUTING_KEY } },
    });
    const config = parseLeadRoutingConfig(configRow?.value ?? null);
    if (!config.enabled) return lead;
    const candidates = routingCandidateIds(config);
    if (candidates.length === 0) return lead;

    const routed = await basePrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`lead-routing:${tenantId}`})::bigint)`;
      const eligibleRows = await tx.$queryRaw<{ id: string; name: string }[]>`
        SELECT u."id", u."name"
        FROM "TenantMember" m
        JOIN "User" u ON u."id" = m."userId"
        JOIN "Tenant" t ON t."id" = m."tenantId"
        WHERE m."tenantId" = ${tenantId} AND t."active" = true AND u."disabledAt" IS NULL
          AND u."id" = ANY(${candidates}::text[])`;
      const lastRow = await tx.appSetting.findUnique({
        where: { tenantId_key: { tenantId, key: LEAD_ROUTING_LAST_KEY } },
      });
      const decision = pickLeadAssignee(
        config,
        { source: lead.source, productId: lead.productId },
        new Set(eligibleRows.map((row) => row.id)),
        lastRow?.value || null,
      );
      if (!decision.userId) return null;
      const updated = await tx.lead.update({
        // Bypass client: the tenant is named in the predicate, not left to the guard.
        where: { id: lead.id, tenantId },
        data: { assignedToId: decision.userId },
      });
      if (decision.rotated) {
        await tx.appSetting.upsert({
          where: { tenantId_key: { tenantId, key: LEAD_ROUTING_LAST_KEY } },
          update: { value: decision.userId },
          create: { tenantId, key: LEAD_ROUTING_LAST_KEY, value: decision.userId },
        });
      }
      const rep = eligibleRows.find((row) => row.id === decision.userId)!;
      return { lead: updated, rep };
    });
    if (!routed) return lead;

    await logAudit({
      action: "lead.assigned",
      summary: `Auto-assigned to ${routed.rep.name} by lead routing`,
      leadId: routed.lead.id,
      contactId: routed.lead.contactId,
      userName: "System",
    });
    return routed.lead;
  } catch (error) {
    const { logError } = await import("./errorLog");
    await logError(
      "lead-routing",
      error,
      "A new inbound lead could not be auto-assigned and was left unassigned. Check Settings → Lead routing.",
      { tenantId },
    );
    return lead;
  }
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
