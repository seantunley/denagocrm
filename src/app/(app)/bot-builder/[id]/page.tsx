import { requireRoute } from "@/lib/permissions";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FlaskConical } from "lucide-react";
import { prisma } from "@/lib/db";
import { DEFAULT_FLOW, type Flow } from "@/lib/flow";
import { enabledFlowChannels } from "@/lib/flowValidationServer";
import FlowBuilder from "@/components/FlowBuilder";
import FlowAiDraftForm from "@/components/FlowAiDraftForm";
import FlowNodeSystemFrame from "@/components/FlowNodeSystemFrame";
import { builderTenantId, flowScope, journeyScope } from "@/lib/flowScope";
import { flowDocumentOptions } from "@/lib/flowDocuments";
import { listActingTenantStaff } from "@/lib/tenantActor";
import { getCompanyProfile } from "@/lib/companyProfile";
import { getSetting } from "@/lib/settings";
import { FLOW_CONNECTIONS_KEY, parseConnections } from "@/lib/flowConnections";
import { getBotFlowVersionAnalytics } from "@/lib/botFlowAnalytics";

const STEP_NUMBERS_DAYS = 30;

export default async function FlowEditorPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRoute("/bot-builder");
  const { id } = await params;
  const scope = await flowScope();
  const row = await prisma.botFlow.findFirst({ where: { id, ...scope } });
  if (!row) notFound();

  let flow: Flow = DEFAULT_FLOW;
  try {
    const f = JSON.parse(row.definition);
    if (f?.start && f?.nodes) flow = f;
  } catch {
    /* use default so the owner can recover/reset the draft */
  }

  // API request steps choose a connection by name; the page never sees a key (lib/flowConnections).
  const connections = parseConnections(await getSetting(FLOW_CONNECTIONS_KEY)).map(({ id, name, host }) => ({ id, name, host }));
  // "Update the CRM": this workspace's tags (pick one, or type a new one) and pipeline stages, with their pipeline.
  const [crmTags, stages] = await Promise.all([
    prisma.tag.findMany({ select: { name: true }, orderBy: { name: "asc" }, take: 300 }).then((rows) => rows.map((t) => t.name)),
    prisma.pipelineStage.findMany({ select: { id: true, name: true, pipeline: { select: { name: true } } }, orderBy: [{ pipelineId: "asc" }, { order: "asc" }] })
      .then((rows) => rows.map((s) => ({ id: s.id, name: `${s.pipeline.name} · ${s.name}` }))),
  ]);
  // LIVE NUMBERS ON EACH STEP (Node-RED's node status; Sean, 2026-11-02): the last 30 days, across every published
  // version of this flow, from the same per-step analytics the Bot analytics page reads. Nothing published: none.
  const versionIds = (await prisma.botFlowVersion.findMany({ where: { flowId: id, tenantId: await builderTenantId() }, select: { id: true } })).map((v) => v.id);
  // CHANGED SINCE PUBLISH: the last published version, so the canvas can mark what this draft has changed since.
  const published = await prisma.botFlowVersion.findFirst({ where: { flowId: id, tenantId: await builderTenantId() }, orderBy: { version: "desc" }, select: { version: true, definition: true } });
  const stepNumbers = Object.fromEntries(
    (await getBotFlowVersionAnalytics(versionIds, { occurredFrom: new Date(Date.now() - STEP_NUMBERS_DAYS * 86_400_000) })).nodes
      // `entered` counts every step the engine ran (automatic ones too); `reached` (waits) covers question steps in
      // days recorded before `entered` existed. A step that waits is entered once per wait, so the larger is right.
      .map((n) => [n.nodeId, { reached: Math.max(n.entered, n.reached), interacted: n.interacted }]),
  );
  const [channels, journeys, reusableFlows, company, documents, staff] = await Promise.all([
    enabledFlowChannels(),
    prisma.journey.findMany({
      where: { status: "active", ...(await journeyScope()) },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    // Candidates for the Run-subflow picker: every other flow in THIS workspace.
    // The picker may list an unpublished one — publication then refuses it with
    // subflow.unavailable, which is a better conversation than an empty list.
    prisma.botFlow.findMany({ where: { ...scope, id: { not: id } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    getCompanyProfile(),
    // "Send a document": this workspace's own general files only (flowDocuments — the same rule as save and send).
    builderTenantId().then((tenantId) => flowDocumentOptions(tenantId)),
    // "Send contact card": the business's card, or one of this workspace's staff.
    listActingTenantStaff().then((rows) => rows.map((s) => ({ id: s.id, name: s.name }))),
  ]);
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <Link href="/bot-builder" className="text-sm text-orange-400 hover:underline">← All flows</Link>
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            <h1 className="text-2xl font-semibold tracking-[-0.035em]">{row.name}</h1>
            {row.active && <span className="badge bg-emerald-500/15 text-emerald-300">Published flow</span>}
          </div>
          <p className="text-sm text-slate-400 mt-0.5">
            You are editing a draft. Save keeps these changes private; publish them from All flows when they are ready for customers.
          </p>
        </div>
        <Link href={`/bot-builder/${row.id}/test`} className="btn-secondary btn-sm"><FlaskConical className="size-4" />Test saved draft</Link>
      </div>
      <FlowAiDraftForm flowId={row.id} />
      <FlowNodeSystemFrame>
        <FlowBuilder flowId={row.id} initial={flow} journeys={journeys} flows={reusableFlows} updatedAt={row.updatedAt.toISOString()} channels={channels} businessName={company.name} documents={documents} staff={staff} connections={connections} crmTags={crmTags} stages={stages} stepNumbers={stepNumbers} stepNumbersDays={STEP_NUMBERS_DAYS} published={published ?? undefined} />
      </FlowNodeSystemFrame>
    </div>
  );
}
