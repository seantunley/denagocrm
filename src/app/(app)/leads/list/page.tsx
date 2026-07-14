import Link from "next/link";
import { ListFilter } from "lucide-react";
import { subDays } from "date-fns";
import { prisma } from "@/lib/db";
import { saveView, deleteView } from "@/app/actions/views";
import { formatDate, formatZAR } from "@/lib/format";
import { getAccessibleLeadIds, requireAnyPermission } from "@/lib/permissions";
import { listActiveSalesPipelines, listPipelineStages } from "@/lib/pipelines";
import MobileFilterDrawer from "@/components/MobileFilterDrawer";
import { EmptyState, StatusPill } from "@/components/visual-system";
import {
  MobileDataCard,
  MobileDataField,
  MobileDataFields,
  MobileDataHeader,
  MobileDataList,
  ResponsiveDataView,
  StickyActionArea,
} from "@/components/responsive-patterns";

export const metadata = { title: "Lead list — DenagoCRM" };

type Params = {
  status?: string;
  source?: string;
  pipeline?: string;
  stageId?: string;
  minValue?: string;
  days?: string;
};

type FilterOption = { id: string; name: string };

export default async function LeadListPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await requireAnyPermission("leads.view_all", "leads.view_owned");
  const params = await searchParams;
  const status = params.status || "";
  const source = params.source || "";
  const pipelineId = params.pipeline || "";
  const stageId = params.stageId || "";
  const minValue = parseInt(params.minValue || "", 10);
  const days = parseInt(params.days || "", 10);

  const [pipelines, accessibleIds, views] = await Promise.all([
    listActiveSalesPipelines(),
    getAccessibleLeadIds(user),
    prisma.savedView.findMany({ where: { page: "leads" }, orderBy: { createdAt: "asc" } }),
  ]);
  const selectedPipeline = pipelines.find((pipeline) => pipeline.id === pipelineId) ?? null;
  const stages = selectedPipeline
    ? await listPipelineStages(selectedPipeline.id)
    : (await Promise.all(pipelines.map((pipeline) => listPipelineStages(pipeline.id)))).flat();
  const selectedPipelineStageIds = selectedPipeline ? stages.map((stage) => stage.id) : [];

  const leads = await prisma.lead.findMany({
    where: {
      ...(accessibleIds ? { id: { in: accessibleIds } } : {}),
      ...(status ? { status } : {}),
      ...(source ? { source } : {}),
      ...(stageId
        ? { stageId }
        : selectedPipeline
          ? { stageId: { in: selectedPipelineStageIds } }
          : {}),
      ...(!isNaN(minValue) && minValue > 0 ? { valueCents: { gte: minValue * 100 } } : {}),
      ...(!isNaN(days) && days > 0 ? { createdAt: { gte: subDays(new Date(), days) } } : {}),
    },
    include: { stage: true, product: true, contact: true, assignedTo: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const currentQuery = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, value]) => value)) as Record<string, string>,
  ).toString();
  const totalValue = leads.reduce((sum, lead) => sum + lead.valueCents, 0);
  const activeFilterCount = Object.values(params).filter(Boolean).length;

  const filterProps = { params, status, source, pipelineId, stageId, pipelines, stages };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.035em]">Lead list</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Filter accessible leads, save the view, and return to it in one click.{" "}
            <Link href="/leads" className="text-primary hover:underline">Board view →</Link>
          </p>
        </div>
      </div>

      {views.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/leads/list" className={`badge cursor-pointer ${!currentQuery ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground hover:text-foreground"}`}>All leads</Link>
          {views.map((view) => (
            <span key={view.id} className="inline-flex items-center gap-1">
              <Link href={`/leads/list?${view.query}`} className={`badge cursor-pointer ${currentQuery === view.query ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground hover:text-foreground"}`}>{view.name}</Link>
              <form action={deleteView.bind(null, view.id)}><button className="text-xs text-muted-foreground hover:text-red-400" title="Delete view">×</button></form>
            </span>
          ))}
        </div>
      )}

      <MobileFilterDrawer activeCount={activeFilterCount} title="Lead filters">
        <form method="GET" className="space-y-4 [&_.input]:w-full">
          <LeadFilterFields {...filterProps} />
          <StickyActionArea className="grid grid-cols-2">
            <button className="btn-primary">Apply filters</button>
            {currentQuery ? <Link href="/leads/list" className="btn-secondary">Clear</Link> : <span />}
          </StickyActionArea>
        </form>
      </MobileFilterDrawer>

      <form method="GET" className="card hidden flex-wrap items-end gap-3 p-4 sm:flex">
        <LeadFilterFields {...filterProps} />
        <button className="btn-primary btn-sm">Filter</button>
        {currentQuery && <Link href="/leads/list" className="btn-secondary btn-sm">Clear</Link>}
      </form>

      {currentQuery && (
        <form action={saveView} className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input type="hidden" name="page" value="leads" />
          <input type="hidden" name="query" value={currentQuery} />
          <input name="name" className="input text-sm sm:w-64" placeholder="Name this view" required />
          <button className="btn-secondary btn-sm">Save view</button>
        </form>
      )}

      {leads.length === 0 ? (
        <EmptyState icon={ListFilter} title="No leads match these filters" description="Clear or adjust the active filters to widen the result set." />
      ) : (
        <ResponsiveDataView
          mobile={
            <MobileDataList>
              {leads.map((lead) => (
                <MobileDataCard key={lead.id}>
                  <MobileDataHeader
                    title={<Link href={`/leads/${lead.id}`} className="text-primary hover:underline">{lead.name}</Link>}
                    detail={lead.title}
                    aside={<StatusPill tone={lead.status === "won" ? "success" : lead.status === "lost" ? "danger" : "info"}>{lead.status === "open" ? lead.stage.name : lead.status}</StatusPill>}
                  />
                  <MobileDataFields>
                    <MobileDataField label="Value">{lead.valueCents > 0 ? formatZAR(lead.valueCents) : "—"}</MobileDataField>
                    <MobileDataField label="Source"><span className="capitalize">{lead.source}</span></MobileDataField>
                    <MobileDataField label="Assigned">{lead.assignedTo?.name ?? "Unassigned"}</MobileDataField>
                    <MobileDataField label="Created">{formatDate(lead.createdAt)}</MobileDataField>
                  </MobileDataFields>
                </MobileDataCard>
              ))}
              <div className="border-t border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
                {leads.length} lead{leads.length !== 1 ? "s" : ""} · <span className="font-semibold text-foreground">{formatZAR(totalValue)}</span> total
              </div>
            </MobileDataList>
          }
          desktop={
            <div className="card overflow-x-auto p-0">
              <table className="table-base">
                <thead><tr><th>Lead</th><th>Stage</th><th>Source</th><th className="text-right">Value</th><th>Created</th><th>Assigned</th></tr></thead>
                <tbody>
                  {leads.map((lead) => (
                    <tr key={lead.id}>
                      <td><Link href={`/leads/${lead.id}`} className="font-medium text-primary hover:underline">{lead.name}</Link><p className="max-w-52 truncate text-xs text-muted-foreground">{lead.title}</p></td>
                      <td>{lead.status === "open" ? <span className="badge text-white" style={{ backgroundColor: lead.stage.color }}>{lead.stage.name}</span> : <StatusPill tone={lead.status === "won" ? "success" : "danger"}>{lead.status}</StatusPill>}</td>
                      <td className="text-sm capitalize text-foreground/80">{lead.source}</td>
                      <td className="text-right font-medium">{lead.valueCents > 0 ? formatZAR(lead.valueCents) : "—"}</td>
                      <td className="text-sm text-muted-foreground">{formatDate(lead.createdAt)}</td>
                      <td className="text-sm text-muted-foreground">{lead.assignedTo?.name ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">{leads.length} lead{leads.length !== 1 ? "s" : ""} · total value <span className="font-semibold text-foreground">{formatZAR(totalValue)}</span></p>
            </div>
          }
        />
      )}
    </div>
  );
}

function LeadFilterFields({ params, status, source, pipelineId, stageId, pipelines, stages }: {
  params: Params;
  status: string;
  source: string;
  pipelineId: string;
  stageId: string;
  pipelines: FilterOption[];
  stages: FilterOption[];
}) {
  return (
    <>
      <label className="space-y-1"><span className="label">Status</span><select name="status" className="input w-32" defaultValue={status}><option value="">Any</option><option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option></select></label>
      <label className="space-y-1"><span className="label">Source</span><select name="source" className="input w-36" defaultValue={source}><option value="">Any</option><option value="facebook">Facebook</option><option value="instagram">Instagram</option><option value="website">Website</option><option value="whatsapp">WhatsApp</option><option value="referral">Referral</option><option value="manual">Manual</option><option value="walk-in">Walk-in</option></select></label>
      <label className="space-y-1"><span className="label">Pipeline</span><select name="pipeline" className="input w-44" defaultValue={pipelineId}><option value="">Any</option>{pipelines.map((pipeline) => <option key={pipeline.id} value={pipeline.id}>{pipeline.name}</option>)}</select></label>
      <label className="space-y-1"><span className="label">Stage</span><select name="stageId" className="input w-40" defaultValue={stageId}><option value="">Any</option>{stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></label>
      <label className="space-y-1"><span className="label">Value at least (R)</span><input name="minValue" type="number" className="input w-32" defaultValue={params.minValue ?? ""} /></label>
      <label className="space-y-1"><span className="label">Created in last days</span><input name="days" type="number" className="input w-32" defaultValue={params.days ?? ""} /></label>
    </>
  );
}
