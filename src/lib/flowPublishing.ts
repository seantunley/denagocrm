import { prisma } from "./db";
import { DEFAULT_FLOW, type Flow } from "./flow";
import { withTenantWrite } from "./tenantWrite";
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
  if (pinnedVersionId) {
    const pinned = await prisma.botFlowVersion.findUnique({ where: { id: pinnedVersionId } });
    const flow = pinned ? parseFlow(pinned.definition) : null;
    if (!pinned || !flow) throw new PinnedFlowVersionUnavailableError(pinnedVersionId);
    return { flow, versionId: pinned.id, flowId: pinned.flowId };
  }

  const publication =
    (await prisma.botFlowPublication.findFirst({ where: { channel } })) ??
    (channel === "whatsapp"
      ? null
      : await prisma.botFlowPublication.findFirst({ where: { channel: "whatsapp" } }));

  if (publication) {
    const version = await prisma.botFlowVersion.findUnique({ where: { id: publication.versionId } });
    const flow = version ? parseFlow(version.definition) : null;
    if (version && flow) return { flow, versionId: version.id, flowId: version.flowId };
  }

  const legacy =
    (await prisma.botFlow.findFirst({ where: { channel, active: true } })) ??
    (channel === "whatsapp"
      ? null
      : await prisma.botFlow.findFirst({ where: { channel: "whatsapp", active: true } }));
  if (legacy) {
    const flow = parseFlow(legacy.definition);
    if (flow) return { flow, versionId: null, flowId: legacy.id };
  }

  return { flow: DEFAULT_FLOW, versionId: null, flowId: null };
}

/**
 * Publish the CURRENT draft as a new immutable version. Every caller passes the
 * same graph/channel compiler before customer-facing publication.
 */
export async function publishFlowSnapshot(
  flowId: string,
  actorId?: string | null,
): Promise<{ versionId: string; version: number; channel: string }> {
  const draft = await prisma.botFlow.findUnique({ where: { id: flowId } });
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
    const flow = await tx.botFlow.findFirst({ where: { id: flowId, tenantId } });
    if (!flow) throw new Error("FLOW_NOT_FOUND");
    if (flow.definition !== draft.definition) throw new Error("FLOW_CHANGED_DURING_PUBLISH");

    const max = await tx.botFlowVersion.aggregate({ where: { tenantId, flowId }, _max: { version: true } });
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

    await tx.botFlow.updateMany({ where: { tenantId, channel: flow.channel }, data: { active: false } });
    await tx.botFlow.updateMany({ where: { id: flow.id, tenantId }, data: { active: true } });
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

export async function getFlowPublicationMeta(): Promise<Map<string, { versionId: string; publishedAt: Date }>> {
  const publications = await prisma.botFlowPublication.findMany();
  return new Map(publications.map((p) => [p.flowId, { versionId: p.versionId, publishedAt: p.publishedAt }]));
}
