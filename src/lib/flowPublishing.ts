import { prisma } from "./db";
import { DEFAULT_FLOW, pinSubflows, type Flow } from "./flow";
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

/**
 * Resolve the immutable graph a conversation should execute — or null when the channel's flow was TAKEN OFFLINE
 * (see below): then nothing answers a new conversation and the message waits in the inbox for a person.
 */
export async function resolveFlowSnapshot(
  channel: string,
  pinnedVersionId?: string | null,
  entry?: FlowEntryContext | null,
): Promise<FlowSnapshot | null> {
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
  const own = await prisma.botFlowPublication.findFirst({ where: { tenantId, channel } });
  // THIS CHANNEL'S OWN FLOW WAS TAKEN OFFLINE (review of #956): it has been published on this channel before and
  // nothing is published here now. Messenger must then answer nobody — not fall back to WhatsApp's flow below, which
  // is for a channel that never had a flow of its own.
  if (!own && channel !== "whatsapp" && (await everPublishedOn(tenantId, [channel]))) return null;
  const publication =
    own ??
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

  // TAKEN OFFLINE (Sean, 2026-11-02: "there is no way to take a flow from live to off"). This channel has been
  // published before and nothing is published now — only "Take offline" removes a publication — so the built-in
  // default must not quietly take its place: no flow answers. Routes (QR codes, keywords) were resolved above and
  // still do; a conversation already in a flow keeps its pinned version until it ends. Publishing again restores it.
  if (await everPublishedOn(tenantId, channel === "whatsapp" ? ["whatsapp"] : [channel, "whatsapp"])) return null;

  return { flow: DEFAULT_FLOW, versionId: null, flowId: null };
}

/** Has a flow ever been published on these channels in this workspace? Versions are history and stay. */
async function everPublishedOn(tenantId: string, channels: string[]): Promise<boolean> {
  return Boolean(await prisma.botFlowVersion.findFirst({ where: { tenantId, channel: { in: channels } }, select: { id: true } }));
}

/**
 * Take a channel's live flow off the air (the bot builder's "Take offline"). The flow stops being the live one —
 * marked inactive FIRST, so the legacy fallback can never pick up its unpublished draft — then its publication is
 * removed. Its versions stay as history; Publish puts it back. Returns false when it was not the live flow.
 */
export async function takeFlowOffline(flowId: string): Promise<boolean> {
  const tenantId = await builderTenantId();
  const flow = await prisma.botFlow.findFirst({ where: { id: flowId, ...flowTenantWhere(tenantId) }, select: { id: true, channel: true, active: true } });
  if (!flow?.active) return false;
  // One transaction (review of #956): never a flow marked off whose publication still answers, or the reverse.
  // withTenantWrite for its transaction only, as publishFlowSnapshot uses it — the tenant is builderTenantId() above.
  await withTenantWrite(async (tx) => {
    await tx.botFlow.updateMany({ where: { id: flow.id, ...flowTenantWhere(tenantId) }, data: { active: false } });
    await tx.botFlowPublication.deleteMany({ where: { tenantId, channel: flow.channel, flowId: flow.id } });
  });
  return true;
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
    // PIN EVERY SUBFLOW to its newest published version, in the version only (the draft keeps tracking the latest):
    // a shared subflow published later must not change this flow while it is live (review, 2026-11-02).
    const subflowIds = [...new Set(Object.values(parsed.nodes).flatMap((n) => (n.type === "subflow" && n.flowId ? [n.flowId] : [])))];
    const latest = new Map<string, { id: string; version: number }>();
    if (subflowIds.length) {
      const rows = await tx.botFlowVersion.findMany({ where: { tenantId, flowId: { in: subflowIds } }, orderBy: { version: "desc" }, select: { id: true, flowId: true, version: true } });
      for (const row of rows) if (!latest.has(row.flowId)) latest.set(row.flowId, { id: row.id, version: row.version });
    }
    const snapshot = await tx.botFlowVersion.create({
      data: {
        tenantId,
        flowId,
        channel: flow.channel,
        version,
        definition: latest.size ? JSON.stringify(pinSubflows(JSON.parse(flow.definition) as Flow, latest)) : flow.definition,
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

    // A route selects a flow, not a one-time release of that flow. Advance every
    // matching rule in the same transaction as the channel default so one click
    // on Publish cannot leave routed customers on the previous version. Include
    // disabled routes as well: re-enabling a rule later must not revive stale
    // conversation behaviour.
    await tx.botFlowRoute.updateMany({
      where: { tenantId, flowId: flow.id, channel: flow.channel },
      data: { publishedVersionId: snapshot.id },
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
