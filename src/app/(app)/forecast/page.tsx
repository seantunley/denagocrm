import Link from "next/link";
import { basePrisma } from "@/lib/db";
import { formatDate, formatDateTime, formatZAR, formatZARCompact } from "@/lib/format";
import { getAccessibleLeadScope, hasPermission, requirePermission } from "@/lib/permissions";
import { listActiveSalesPipelines, listForecastLeads, summarizeForecast } from "@/lib/pipelines";
import { saveLeadForecast, snapshotForecast } from "@/app/actions/pipelines";

export const dynamic = "force-dynamic";

type TeamRow = { id: string; name: string };
type UserRow = { id: string; name: string };
type SnapshotRow = {
  id: string; period: string; pipelineName: string | null; teamName: string | null; userName: string | null;
  openValueCents: bigint; weightedValueCents: bigint; commitValueCents: bigint;
  bestCaseValueCents: bigint; opportunityCount: number; capturedAt: Date;
};

function monthRange(value?: string) {
  const period = value && /^\d{4}-\d{2}$/.test(value) ? value : new Date().toISOString().slice(0, 7);
  const [year, month] = period.split("-").map(Number);
  return { period, from: new Date(Date.UTC(year, month - 1, 1)), to: new Date(Date.UTC(year, month, 1)) };
}

export default async function ForecastPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePermission("forecast.view");
  const params = await searchParams;
  const pipelineId = typeof params.pipeline === "string" ? params.pipeline : null;
  const teamId = typeof params.team === "string" ? params.team : null;
  const ownerId = typeof params.user === "string" ? params.user : null;
  const range = monthRange(typeof params.period === "string" ? params.period : undefined);

  const [pipelines, teams, users] = await Promise.all([
    listActiveSalesPipelines(),
    basePrisma.$queryRaw<TeamRow[]>`SELECT "id", "name" FROM "Team" WHERE "active" = true AND "deletedAt" IS NULL ORDER BY "name"`,
    basePrisma.$queryRaw<UserRow[]>`SELECT "id", "name" FROM "User" ORDER BY "name"`,
  ]);

  const scope = await getAccessibleLeadScope(user);
  let leads = await listForecastLeads({ pipelineId, teamId, userId: ownerId, closeFrom: range.from, closeTo: range.to });
  if (!scope.viewAll) leads = leads.filter((lead) => lead.assignedToId === scope.userId || Boolean(lead.teamId && scope.teamIds.includes(lead.teamId)));
  const summary = summarizeForecast(leads);
  const canManage = await hasPermission(user, "forecast.manage");

  const snapshots = await basePrisma.$queryRaw<SnapshotRow[]>`
    SELECT fs."id", fs."period", p."name" AS "pipelineName", t."name" AS "teamName", u."name" AS "userName",
      fs."openValueCents", fs."weightedValueCents", fs."commitValueCents", fs."bestCaseValueCents",
      fs."opportunityCount", fs."capturedAt"
    FROM "ForecastSnapshot" fs
    LEFT JOIN "SalesPipeline" p ON p."id" = fs."pipelineId"
    LEFT JOIN "Team" t ON t."id" = fs."teamId"
    LEFT JOIN "User" u ON u."id" = fs."userId"
    ORDER BY fs."capturedAt" DESC LIMIT 20
  `;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div><h1 className="text-2xl font-bold">Sales forecast</h1><p className="text-sm text-slate-400 mt-1">Weighted, commit and best-case pipeline for {range.period}.</p></div>
        {canManage && <form action={snapshotForecast}>
          <input type="hidden" name="period" value={range.period} /><input type="hidden" name="pipelineId" value={pipelineId ?? ""} />
          <input type="hidden" name="teamId" value={teamId ?? ""} /><input type="hidden" name="userId" value={ownerId ?? ""} />
          <button className="btn-secondary">Capture snapshot</button>
        </form>}
      </div>

      <form className="card grid md:grid-cols-5 gap-3 items-end">
        <label className="space-y-1"><span className="text-xs text-slate-400">Period</span><input type="month" name="period" className="input" defaultValue={range.period} /></label>
        <label className="space-y-1"><span className="text-xs text-slate-400">Pipeline</span><select name="pipeline" className="input" defaultValue={pipelineId ?? ""}><option value="">All pipelines</option>{pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="space-y-1"><span className="text-xs text-slate-400">Team</span><select name="team" className="input" defaultValue={teamId ?? ""}><option value="">All teams</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <label className="space-y-1"><span className="text-xs text-slate-400">Owner</span><select name="user" className="input" defaultValue={ownerId ?? ""}><option value="">All owners</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        <button className="btn-primary">Apply</button>
      </form>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        {[["Open", formatZARCompact(summary.openValueCents)], ["Weighted", formatZARCompact(summary.weightedValueCents)], ["Commit", formatZARCompact(summary.commitValueCents)], ["Best case", formatZARCompact(summary.bestCaseValueCents)], ["Pipeline", formatZARCompact(summary.pipelineValueCents)], ["Deals", String(summary.count)]].map(([label, value]) => <div key={label} className="card"><p className="text-xs uppercase text-slate-400">{label}</p><p className="text-xl font-bold mt-1">{value}</p></div>)}
      </div>

      <div className="card p-0 overflow-x-auto"><table className="table-base">
        <thead><tr><th>Lead</th><th>Pipeline / stage</th><th>Owner</th><th>Close</th><th>Category</th><th>Probability</th><th className="text-right">Value</th><th className="text-right">Weighted</th><th>Edit</th></tr></thead>
        <tbody>{leads.length === 0 && <tr><td colSpan={9} className="text-center py-8 text-slate-400">No open leads match this forecast period.</td></tr>}
          {leads.map((lead) => <tr key={lead.id}>
            <td><Link href={`/leads/${lead.id}`} className="text-orange-400 font-medium hover:underline">{lead.title}</Link><p className="text-xs text-slate-500">{lead.name}</p></td>
            <td>{lead.pipelineName}<p className="text-xs text-slate-500">{lead.stageName}</p></td><td>{lead.assignedToName ?? "Unassigned"}<p className="text-xs text-slate-500">{lead.teamName ?? "No team"}</p></td>
            <td>{formatDate(lead.expectedCloseDate)}</td><td>{lead.forecastCategory.replace("_", " ")}</td><td>{lead.probability}%</td>
            <td className="text-right">{formatZAR(lead.valueCents)}</td><td className="text-right">{formatZAR(Math.round(lead.valueCents * lead.probability / 100))}</td>
            <td>{canManage && <details><summary className="cursor-pointer text-orange-400 text-xs">Edit</summary><form action={saveLeadForecast.bind(null, lead.id)} className="space-y-2 mt-2 min-w-52">
              <input name="probability" type="number" min="0" max="100" className="input" defaultValue={lead.probability} />
              <select name="forecastCategory" className="input" defaultValue={lead.forecastCategory}><option value="pipeline">Pipeline</option><option value="best_case">Best case</option><option value="commit">Commit</option><option value="omitted">Omitted</option></select>
              <input name="expectedCloseDate" type="date" className="input" defaultValue={lead.expectedCloseDate?.toISOString().slice(0, 10) ?? ""} />
              <input name="estimatedCost" className="input" placeholder="Estimated cost (R)" defaultValue={lead.estimatedCostCents != null ? lead.estimatedCostCents / 100 : ""} />
              <select name="teamId" className="input" defaultValue={lead.teamId ?? ""}><option value="">No team</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
              <button className="btn-primary btn-sm">Save</button>
            </form></details>}</td>
          </tr>)}</tbody>
      </table></div>

      <div className="card"><h2 className="font-semibold mb-4">Recent snapshots</h2>{snapshots.length === 0 ? <p className="text-sm text-slate-400">No snapshots yet.</p> : <ul className="divide-y divide-slate-800">{snapshots.map((s) => <li key={s.id} className="py-2 text-sm flex gap-3"><div className="flex-1"><p>{s.period} · {s.pipelineName ?? "All pipelines"} · {s.teamName ?? "All teams"} · {s.userName ?? "All owners"}</p><p className="text-xs text-slate-500">Open {formatZAR(Number(s.openValueCents))} · Weighted {formatZAR(Number(s.weightedValueCents))} · {s.opportunityCount} deals · {formatDateTime(s.capturedAt)}</p></div></li>)}</ul>}</div>
    </div>
  );
}
