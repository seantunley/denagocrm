import Link from "next/link";
import { subDays } from "date-fns";
import { prisma } from "@/lib/db";
import { saveView, deleteView } from "@/app/actions/views";
import { formatDate, formatZAR } from "@/lib/format";
import { getAccessibleLeadIds, requireAnyPermission } from "@/lib/permissions";
import { listActiveSalesPipelines, listPipelineStages } from "@/lib/pipelines";

export const metadata = { title: "Lead list — DenagoCRM" };

type Params = {
  status?: string;
  source?: string;
  pipeline?: string;
  stageId?: string;
  minValue?: string;
  days?: string;
};

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
    Object.fromEntries(Object.entries(params).filter(([, value]) => value)) as Record<string, string>
  ).toString();
  const totalValue = leads.reduce((sum, lead) => sum + lead.valueCents, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.035em]">Lead list</h1>
          <p className="text-sm text-slate-400 mt-1">
            Filter accessible leads, save the view, and return to it in one click. {" "}
            <Link href="/leads" className="text-orange-400 hover:underline">Board view →</Link>
          </p>
        </div>
      </div>

      {views.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <Link href="/leads/list" className={`badge cursor-pointer ${!currentQuery ? "bg-orange-500/15 text-orange-300" : "bg-slate-800 text-slate-300 hover:text-white"}`}>
            All leads
          </Link>
          {views.map((view) => (
            <span key={view.id} className="inline-flex items-center gap-1">
              <Link href={`/leads/list?${view.query}`} className={`badge cursor-pointer ${currentQuery === view.query ? "bg-orange-500/15 text-orange-300" : "bg-slate-800 text-slate-300 hover:text-white"}`}>
                {view.name}
              </Link>
              <form action={deleteView.bind(null, view.id)}>
                <button className="text-slate-600 hover:text-red-400 text-xs cursor-pointer" title="Delete view">✕</button>
              </form>
            </span>
          ))}
        </div>
      )}

      <form method="GET" className="card p-4 flex items-end gap-3 flex-wrap">
        <label className="space-y-1">
          <span className="label">Status</span>
          <select name="status" className="input w-32" defaultValue={status}>
            <option value="">Any</option><option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option>
          </select>
        </label>
        <label className="space-y-1">
          <span className="label">Source</span>
          <select name="source" className="input w-36" defaultValue={source}>
            <option value="">Any</option><option value="facebook">Facebook</option><option value="instagram">Instagram</option>
            <option value="website">Website</option><option value="whatsapp">WhatsApp</option><option value="referral">Referral</option>
            <option value="manual">Manual</option><option value="walk-in">Walk-in</option>
          </select>
        </label>
        <label className="space-y-1">
          <span className="label">Pipeline</span>
          <select name="pipeline" className="input w-44" defaultValue={pipelineId}>
            <option value="">Any</option>
            {pipelines.map((pipeline) => <option key={pipeline.id} value={pipeline.id}>{pipeline.name}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="label">Stage</span>
          <select name="stageId" className="input w-40" defaultValue={stageId}>
            <option value="">Any</option>
            {stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="label">Value at least (R)</span>
          <input name="minValue" type="number" className="input w-32" defaultValue={params.minValue ?? ""} />
        </label>
        <label className="space-y-1">
          <span className="label">Created in last days</span>
          <input name="days" type="number" className="input w-32" defaultValue={params.days ?? ""} />
        </label>
        <button className="btn-primary btn-sm">Filter</button>
        {currentQuery && <Link href="/leads/list" className="btn-secondary btn-sm">Clear</Link>}
      </form>

      {currentQuery && (
        <form action={saveView} className="flex items-center gap-2">
          <input type="hidden" name="page" value="leads" />
          <input type="hidden" name="query" value={currentQuery} />
          <input name="name" className="input w-64 text-sm" placeholder="Name this view" required />
          <button className="btn-secondary btn-sm">💾 Save view</button>
        </form>
      )}

      <div className="card p-0 overflow-x-auto">
        <table className="table-base">
          <thead><tr><th>Lead</th><th>Stage</th><th>Source</th><th className="text-right">Value</th><th>Created</th><th>Assigned</th></tr></thead>
          <tbody>
            {leads.length === 0 && <tr><td colSpan={6} className="text-center text-slate-400 py-8">Nothing accessible matches these filters.</td></tr>}
            {leads.map((lead) => (
              <tr key={lead.id}>
                <td>
                  <Link href={`/leads/${lead.id}`} className="font-medium text-orange-400 hover:underline">{lead.name}</Link>
                  <p className="text-xs text-slate-400 truncate max-w-52">{lead.title}</p>
                </td>
                <td>
                  {lead.status === "open" ? (
                    <span className="badge text-white" style={{ backgroundColor: lead.stage.color }}>{lead.stage.name}</span>
                  ) : (
                    <span className={`badge ${lead.status === "won" ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>{lead.status}</span>
                  )}
                </td>
                <td className="text-sm capitalize text-slate-300">{lead.source}</td>
                <td className="text-right font-medium">{lead.valueCents > 0 ? formatZAR(lead.valueCents) : "—"}</td>
                <td className="text-sm text-slate-400">{formatDate(lead.createdAt)}</td>
                <td className="text-sm text-slate-400">{lead.assignedTo?.name ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {leads.length > 0 && (
          <p className="px-4 py-2.5 text-xs text-slate-400 border-t border-slate-800">
            {leads.length} lead{leads.length !== 1 ? "s" : ""} · total value {" "}
            <span className="font-semibold text-slate-200">{formatZAR(totalValue)}</span>
          </p>
        )}
      </div>
    </div>
  );
}
