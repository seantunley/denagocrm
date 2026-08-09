import { prisma } from "./db";
import { DEFAULT_FLOW, type Flow } from "./flow";
import { withTenantWrite } from "./tenantWrite";

export type FlowSnapshot = {
  flow: Flow;
  versionId: string | null;
  flowId: string | null;
};

function parseFlow(definition: string): Flow | null {
  try {
    const parsed = JSON.parse(definition);
    if (parsed?.start && parsed?.nodes?.[parsed.start]) return parsed as Flow;
  } catch {
    // Invalid legacy data falls through to the safe default exactly as before.
  }
  return null;
}

/**
 * Resolve the immutable graph a conversation should execute.
 *
 * A pinned version ALWAYS wins. New sessions take the current publication for
 * their channel (or the WhatsApp publication as the existing cross-channel
 * fallback). Until every installation has republished once, the old BotFlow.active
 * row remains a backwards-compatible fallback.
 */
export async function resolveFlowSnapshot(
  channel: string,
  pinnedVersionId?: string | null,
): Promise<FlowSnapshot> {
  if (pinnedVersionId) {
    const pinned = await prisma.botFlowVersion.findUnique({ where: { id: pinnedVersionId } });
    const flow = pinned ? parseFlow(pinned.definition) : null;
    if (pinned && flow) return { flow, versionId: pinned.id, flowId: pinned.flowId };
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

  // Compatibility path for the first deploy: an existing active flow stays live
  // until the owner explicitly publishes it and creates its first immutable version.
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
 * Publish the CURRENT draft as a new immutable version and atomically switch the
 * channel publication to it. All writes share one transaction; the unique
 * (tenantId, channel) publication row is the database-level "one live flow"
 * invariant that the old updateMany + update pair did not provide concurrently.
 */
export async function publishFlowSnapshot(
  flowId: string,
  actorId?: string | null,
): Promise<{ versionId: string; version: number; channel: string }> {
  return withTenantWrite(async (tx, tenantId) => {
    const flow = await tx.botFlow.findFirst({ where: { id: flowId, tenantId } });
    if (!flow) throw new Error("FLOW_NOT_FOUND");

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

    // Keep the legacy flag truthful for the existing list UI and compatibility
    // readers, but publication itself is governed by the unique row below.
    await tx.botFlow.updateMany({
      where: { tenantId, channel: flow.channel },
      data: { active: false },
    });
    await tx.botFlow.updateMany({
      where: { id: flow.id, tenantId },
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

/** Publication metadata used by the flow library to distinguish live from draft changes. */
export async function getFlowPublicationMeta(): Promise<
  Map<string, { versionId: string; publishedAt: Date }>
> {
  const publications = await prisma.botFlowPublication.findMany();
  return new Map(
    publications.map((p) => [p.flowId, { versionId: p.versionId, publishedAt: p.publishedAt }]),
  );
}
