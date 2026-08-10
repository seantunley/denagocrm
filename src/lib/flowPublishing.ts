import { prisma } from "./db";
import { DEFAULT_FLOW, type Flow } from "./flow";
import { DEFAULT_TENANT_ID } from "./tenant";
import { withTenantWrite, writeTenantId } from "./tenantWrite";
import { nullableTenantWhere } from "./flowTenantScope";
import { flowErrors } from "./flowValidation";
import { FlowPublishValidationError, validateFlowForEnabledChannels } from "./flowValidationServer";

export type FlowSnapshot = {
  flow: Flow;
  versionId: string | null;
  flowId: string | null;
};

export class PinnedFlowVersionUnavailableError extends Error {
  constructor(versionId: string) {
    super(`Pinned chatbot flow version is unavailable: ${versionId}`);
    this.name = "PinnedFlowVersionUnavailableError";
  }
}

/** The tenant whose published flow answers this conversation. */
function flowTenantId(): string {
  return writeTenantId() ?? DEFAULT_TENANT_ID;
}

/**
 * BotFlow predates tenancy and its `tenantId` is still nullable, so the legacy
 * fallback cannot filter strictly without hiding every flow an existing install
 * already has. The founding tenant therefore owns the NULL rows — the same rule
 * statistics.ts applies, and for the same reason. A second tenant sees only its
 * own.
 *
 * The rule itself now lives in flowTenantScope.ts, so the administration surface
 * (the builder, its tools, analytics) filters BotFlow by exactly the predicate
 * the runtime resolves it with, rather than a second copy that could drift.
 */
const legacyFlowTenant = nullableTenantWhere;

function parseFlow(definition: string): Flow | null {
  try {
    const parsed = JSON.parse(definition);
    if (parsed?.start && parsed?.nodes?.[parsed.start]) return parsed as Flow;
  } catch {
    // Invalid legacy data falls through to the safe default exactly as before.
  }
  return null;
}

/** Resolve the immutable graph a conversation should execute. */
export async function resolveFlowSnapshot(
  channel: string,
  pinnedVersionId?: string | null,
): Promise<FlowSnapshot> {
  // BotFlowVersion.tenantId is NOT NULL, so the pin is filtered strictly. A
  // conversation's pinned version is always one this tenant published; naming the
  // tenant means a pin that somehow points elsewhere fails closed
  // (PinnedFlowVersionUnavailableError) instead of executing another workspace's
  // graph against a real customer.
  const tenantId = flowTenantId();

  if (pinnedVersionId) {
    const pinned = await prisma.botFlowVersion.findFirst({ where: { id: pinnedVersionId, tenantId } });
    const flow = pinned ? parseFlow(pinned.definition) : null;
    if (!pinned || !flow) throw new PinnedFlowVersionUnavailableError(pinnedVersionId);
    return { flow, versionId: pinned.id, flowId: pinned.flowId };
  }

  // Scope the runtime resolver to the owning tenant explicitly.
  //
  // BotFlowPublication is UNIQUE (tenantId, channel), so with the tenant named
  // this is a single deterministic row. Without it, `findFirst` had no tenant
  // predicate AND no ordering: while enforcement is dormant an inbound message
  // could be answered with whichever tenant's published flow Postgres happened to
  // return first. That is not a reporting leak — it is the wrong business logic
  // running against a real customer, and the same shape repeats on the legacy
  // fallback below.
  const publication =
    (await prisma.botFlowPublication.findFirst({ where: { tenantId, channel } })) ??
    (channel === "whatsapp"
      ? null
      : await prisma.botFlowPublication.findFirst({ where: { tenantId, channel: "whatsapp" } }));

  if (publication) {
    const version = await prisma.botFlowVersion.findFirst({ where: { id: publication.versionId, tenantId } });
    const flow = version ? parseFlow(version.definition) : null;
    if (version && flow) return { flow, versionId: version.id, flowId: version.flowId };
  }

  const legacyTenant = legacyFlowTenant(tenantId);
  const legacy =
    (await prisma.botFlow.findFirst({ where: { ...legacyTenant, channel, active: true }, orderBy: { id: "asc" } })) ??
    (channel === "whatsapp"
      ? null
      : await prisma.botFlow.findFirst({ where: { ...legacyTenant, channel: "whatsapp", active: true }, orderBy: { id: "asc" } }));
  if (legacy) {
    const flow = parseFlow(legacy.definition);
    if (flow) return { flow, versionId: null, flowId: legacy.id };
  }

  return { flow: DEFAULT_FLOW, versionId: null, flowId: null };
}

/**
 * Publish the CURRENT draft as a new immutable version.
 *
 * Validation lives HERE rather than only in the builder action: any future
 * caller, script or Server Action must pass the same graph/channel compiler
 * before a version can become customer-facing.
 */
export async function publishFlowSnapshot(
  flowId: string,
  actorId?: string | null,
): Promise<{ versionId: string; version: number; channel: string }> {
  // Named tenant, not a bare id. Publishing is the action that makes a draft
  // customer-facing, so "an owner" holding a flow id from another workspace must
  // get FLOW_NOT_FOUND here rather than a compiler run against someone else's graph.
  const draft = await prisma.botFlow.findFirst({
    where: { id: flowId, ...legacyFlowTenant(flowTenantId()) },
  });
  if (!draft) throw new Error("FLOW_NOT_FOUND");
  const parsed = parseFlow(draft.definition);
  if (!parsed) {
    throw new FlowPublishValidationError([
      { severity: "error", code: "graph.shape", message: "Flow definition is malformed." },
    ]);
  }
  const issues = await validateFlowForEnabledChannels(parsed);
  if (flowErrors(issues).length) throw new FlowPublishValidationError(issues);

  return withTenantWrite(async (tx, tenantId) => {
    // Re-read inside the transaction. If the draft changed between validation
    // and this point, refuse rather than publishing a different definition than
    // the one the compiler approved.
    // `legacyFlowTenant`, not a strict `tenantId`: an existing single-tenant
    // install's flows are all still NULL-tenant, and a strict predicate here
    // would fail every publish on them with FLOW_NOT_FOUND.
    const ownedFlow = legacyFlowTenant(tenantId);
    const flow = await tx.botFlow.findFirst({ where: { id: flowId, ...ownedFlow } });
    if (!flow) throw new Error("FLOW_NOT_FOUND");
    if (flow.definition !== draft.definition) throw new Error("FLOW_CHANGED_DURING_PUBLISH");

    const max = await tx.botFlowVersion.aggregate({
      where: { tenantId, flowId },
      _max: { version: true },
    });
    const version = (max._max.version ?? 0) + 1;
    const snapshot = await tx.botFlowVersion.create({
      data: {
        tenantId,
        flowId,
        channel: flow.channel,
        version,
        definition: flow.definition,
        createdById: actorId ?? null,
      },
    });

    await tx.botFlow.updateMany({
      where: { ...ownedFlow, channel: flow.channel },
      data: { active: false },
    });
    await tx.botFlow.updateMany({
      where: { id: flow.id, ...ownedFlow },
      data: { active: true },
    });

    await tx.botFlowPublication.upsert({
      where: { tenantId_channel: { tenantId, channel: flow.channel } },
      update: {
        flowId: flow.id,
        versionId: snapshot.id,
        publishedById: actorId ?? null,
        publishedAt: new Date(),
      },
      create: {
        tenantId,
        channel: flow.channel,
        flowId: flow.id,
        versionId: snapshot.id,
        publishedById: actorId ?? null,
      },
    });

    return { versionId: snapshot.id, version, channel: flow.channel };
  });
}

export async function getFlowPublicationMeta(): Promise<
  Map<string, { versionId: string; publishedAt: Date }>
> {
  // The builder list renders "published / draft changed" from this map. Unscoped
  // it returned every workspace's publications, so one owner's flow could be
  // labelled from another owner's publication row (flowId keys are unique per
  // tenant, not globally). BotFlowPublication.tenantId is NOT NULL → strict.
  const publications = await prisma.botFlowPublication.findMany({
    where: { tenantId: flowTenantId() },
  });
  return new Map(publications.map((p) => [p.flowId, { versionId: p.versionId, publishedAt: p.publishedAt }]));
}
