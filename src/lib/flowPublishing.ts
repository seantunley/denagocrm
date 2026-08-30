import { prisma } from "./db";
import { DEFAULT_FLOW, type Flow } from "./flow";
import { withTenantWrite } from "./tenantWrite";
import { flowErrors } from "./flowValidation";
import { flowTenantWhere } from "./flowTenantScope";
import { builderTenantId, runtimeFlowTenantId } from "./flowScope";
import { FlowPublishValidationError, validateFlowForEnabledChannels } from "./flowValidationServer";
import { resolveRoutedFlowVersion, type FlowEntryContext } from "./flowRouting";

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

/** The tenant whose published flow answers this conversation. @see ./flowScope */

/**
 * BotFlow's `tenantId` is still nullable, but every row is owned: migration
 * 20260722146000 backfilled the legacy ones and every create site now stamps the
 * builder's workspace. So `flowTenantWhere` is strict equality for every tenant,
 * the founding one included, and a NULL row belongs to nobody — see
 * ./flowTenantScope for why that is the safe direction on a path that DEACTIVATES
 * flows as well as reading them.
 */

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
  entry?: FlowEntryContext | null,
): Promise<FlowSnapshot> {
  if (pinnedVersionId) {
    const pinned = await prisma.botFlowVersion.findFirst({ where: { id: pinnedVersionId, tenantId: runtimeFlowTenantId() } });
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
  const tenantId = runtimeFlowTenantId();
  const routed = await resolveRoutedFlowVersion(tenantId, channel, entry);
  if (routed) {
    const flow = parseFlow(routed.definition);
    if (flow) return { flow, versionId: routed.id, flowId: routed.flowId };
  }
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

  // The pre-publication fallback: an install that has never used Publish still
  // has a draft BotFlow marked `active`, and that is what answers the customer.
  // Scoped to the owning tenant, strictly — an un-owned flow answers for nobody.
  const flowTenant = flowTenantWhere(tenantId);
  const legacy =
    (await prisma.botFlow.findFirst({ where: { ...flowTenant, channel, active: true }, orderBy: { id: "asc" } })) ??
    (channel === "whatsapp"
      ? null
      : await prisma.botFlow.findFirst({ where: { ...flowTenant, channel: "whatsapp", active: true }, orderBy: { id: "asc" } }));
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
  // Publishing is a STAFF action, so the tenant is the session's active workspace
  // — not writeTenantId(), which is null while enforcement is dormant and would
  // publish a second workspace's draft into the founding tenant's live slot.
  const tenantId = await builderTenantId();
  const draft = await prisma.botFlow.findFirst({ where: { id: flowId, ...flowTenantWhere(tenantId) } });
  if (!draft) throw new Error("FLOW_NOT_FOUND");
  const parsed = parseFlow(draft.definition);
  if (!parsed) {
    throw new FlowPublishValidationError([
      { severity: "error", code: "graph.shape", message: "Flow definition is malformed." },
    ]);
  }
  const issues = await validateFlowForEnabledChannels(parsed);
  if (flowErrors(issues).length) throw new FlowPublishValidationError(issues);

  // USER-ORIGINATED, AND ALREADY CORRECT — nothing to convert. `withTenantWrite` is
  // used here for its TRANSACTION only: the callback deliberately does not bind the
  // second parameter, so the dormant-null `writeTenantId() ?? DEFAULT_TENANT_ID`
  // this helper resolves is never read. The tenant is `builderTenantId()` above,
  // which is the same `enforced ?? session ?? founding` ladder
  // `withActingTenantWrite` applies. Swapping the helper would change nothing and
  // would only invite someone to start using the shadowing parameter again —
  // flowBuilderTenantScope.test.ts asserts it stays unbound for exactly that reason.
  return withTenantWrite(async (tx) => {
    // Re-read inside the transaction. If the draft changed between validation
    // and this point, refuse rather than publishing a different definition than
    // the one the compiler approved.
    // THE SAME OWNERSHIP RULE THE READER USES, which is the invariant to
    // preserve here rather than any particular predicate. When the two disagreed
    // — a NULL-tolerant reader and a strict writer — this re-read found nothing
    // and threw FLOW_NOT_FOUND, which setActiveFlow catches into null: the
    // operator clicked Publish and NOTHING happened, no audit, no revalidate, no
    // error. Both sides now go through `flowTenantWhere`, so they cannot drift
    // apart again whatever the rule inside it becomes.
    const flow = await tx.botFlow.findFirst({ where: { id: flowId, ...flowTenantWhere(tenantId) } });
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

    // A DEACTIVATE SWEEP, which is why the rule this predicate carries has to be
    // strict. This takes flows OFF THE AIR by channel; a predicate that admitted
    // un-owned rows would let one workspace's publish silence a flow it does not
    // own, and unlike a bad read that is not recoverable by looking somewhere
    // else — the customer's next message goes unanswered.
    await tx.botFlow.updateMany({
      where: { ...flowTenantWhere(tenantId), channel: flow.channel },
      data: { active: false },
    });
    // Re-stamp the owner while we are here. Publishing is the one moment we
    // certainly know which tenant owns this flow, so it is the cheapest place to
    // repair a row that somehow lost its tenant.
    await tx.botFlow.updateMany({
      where: { id: flow.id, ...flowTenantWhere(tenantId) },
      data: { active: true, tenantId },
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
  const publications = await prisma.botFlowPublication.findMany({ where: { tenantId: await builderTenantId() } });
  return new Map(publications.map((p) => [p.flowId, { versionId: p.versionId, publishedAt: p.publishedAt }]));
}
