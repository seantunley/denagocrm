import Link from "next/link";
import { BadgeDollarSign, Calculator, CircleDollarSign, Crosshair, HandCoins, Layers3 } from "lucide-react";
import { basePrisma } from "@/lib/db";
import { formatDate, formatDateTime, formatZAR, formatZARCompact } from "@/lib/format";
import { getAccessibleLeadScope, hasPermission, requirePermission } from "@/lib/permissions";
import { listActiveSalesPipelines, listForecastLeads, summarizeForecast } from "@/lib/pipelines";
import { saveLeadForecast, snapshotForecast } from "@/app/actions/pipelines";
import { PageHeader } from "@/components/page-header";
import { KpiGrid } from "@/components/responsive-patterns";
import { MetricCard } from "@/components/visual-system";

export const dynamic = "force-dynamic";

type TeamRow = { id: string; name: string };
type UserRow = { id: string; name: string };
type MembershipRow = { teamId: string; userId: string };
type SnapshotRow = {
  id: string;
  period: string;
  pipelineId: string | null;
  teamId: string | null;
  userId: string | null;
  pipelineName: string | null;
  teamName: string | null;
  userName: string | null;
  openValueCents: bigint;
  weightedValueCents: bigint;
  commitValueCents: bigint;
  bestCaseValueCents: bigint;
  opportunityCount: number;
  capturedAt: Date;
};

function monthRange(value?: string) {
  const period = value && /^\d{4}-\d{2}$/.test(value)
    ? value
    : new Date().toISOString().slice(0, 7);
  const [year, month] = period.split("-").map(Number);
  return {
    period,
    from: new Date(Date.UTC(year, month - 1, 1)),
    to: new Date(Date.UTC(year, month, 1)),
  };
}

export default async function ForecastPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission("forecast.view");
  const params = await searchParams;
  const requestedPipelineId = typeof params.pipeline === "string" ? params.pipeline : null;
  const requestedTeamId = typeof params.team === "string" ? params.team : null;
  const requestedOwnerId = typeof params.user === "string" ? params.user : null;
  const range = monthRange(typeof params.period === "string" ? params.period : undefined);

  const [pipelines, allTeams, allUsers, memberships, scope] = await Promise.all([
    listActiveSalesPipelines(),
    basePrisma.$queryRaw<TeamRow[]>`
      SELECT "id", "name" FROM "Team"
      WHERE "active" = true AND "deletedAt" IS NULL ORDER BY "name"
    `,
    basePrisma.$queryRaw<UserRow[]>`SELECT "id", "name" FROM "User" ORDER BY "name"`,
    basePrisma.$queryRaw<MembershipRow[]>`SELECT "teamId", "userId" FROM "TeamMember"`,
    getAccessibleLeadScope(user),
  ]);

  const teams = scope.viewAll
    ? allTeams
    : allTeams.filter((team) => scope.teamIds.includes(team.id));
  const visibleUserIds = new Set<string>([user.id]);
  if (scope.viewAll) {
    for (const item of allUsers) visibleUserIds.add(item.id);
  } else {
    for (const membership of memberships) {
      if (scope.teamIds.includes(membership.teamId)) visibleUserIds.add(membership.userId);
    }
  }
  const users = allUsers.filter((item) => visibleUserIds.has(item.id));

  const pipelineId = pipelines.some((pipeline) => pipeline.id === requestedPipelineId)
    ? requestedPipelineId
    : null;
  const teamId = teams.some((team) => team.id === requestedTeamId) ? requestedTeamId : null;
  const ownerId = users.some((item) => item.id === requestedOwnerId) ? requestedOwnerId : null;

  let leads = await listForecastLeads({
    pipelineId,
    teamId,
    userId: ownerId,
    closeFrom: range.from,
    closeTo: range.to,
  });
  if (!scope.viewAll) {
    leads = leads.filter((lead) =>
      lead.assignedToId === scope.userId
      || Boolean(lead.teamId && scope.teamIds.includes(lead.teamId))
    );
  }
  const summary = summarizeForecast(leads);

  const [canManage, canAssign, canManagePipelines, canViewTeams, canViewAudit] = await Promise.all([
    hasPermission(user, "forecast.manage"),
    hasPermission(user, "leads.assign"),
    hasPermission(user, "pipelines.manage"),
    hasPermission(user, "teams.view"),
    hasPermission(user, "audit.view"),
  ]);

  const snapshotRows = await basePrisma.$queryRaw<SnapshotRow[]>`
    SELECT fs."id", fs."period", fs."pipelineId", fs."teamId", fs."userId",
      p."name" AS "pipelineName", t."name" AS "teamName", u."name" AS "userName",
      fs."openValueCents", fs."weightedValueCents", fs."commitValueCents",
      fs."bestCaseValueCents", fs."opportunityCount", fs."capturedAt"
    FROM "ForecastSnapshot" fs
    LEFT JOIN "SalesPipeline" p ON p."id" = fs."pipelineId"
    LEFT JOIN "Team" t ON t."id" = fs."teamId"
    LEFT JOIN "User" u ON u."id" = fs."userId"
    ORDER BY fs."capturedAt" DESC LIMIT 100
  `;
  const snapshots = (scope.viewAll
    ? snapshotRows
    : snapshotRows.filter((snapshot) =>
        snapshot.userId === user.id
        || Boolean(snapshot.teamId && scope.teamIds.includes(snapshot.teamId))
      )
  ).slice(0, 20);

  return (
    <div className="space-y-6">
      <PageHeader title="Sales forecast" description={`Weighted, commit and best-case pipeline for ${range.period}.`}>
          {canManagePipelines && <Link href="/settings/pipelines" className="btn-secondary">Pipelines</Link>}
          {canViewTeams && <Link href="/settings/access" className="btn-secondary">Teams &amp; roles</Link>}
          {canViewAudit && <Link href="/audit" className="btn-secondary">Audit</Link>}
          {canManage && (
            <form action={snapshotForecast}>
              <input type="hidden" name="period" value={range.period} />
              <input type="hidden" name="pipelineId" value={pipelineId ?? ""} />
              <input type="hidden" name="teamId" value={teamId ?? ""} />
              <input type="hidden" name="userId" value={ownerId ?? ""} />
              <button className="btn-secondary">Capture snapshot</button>
            </form>
          )}
      </PageHeader>

      <form className="card grid md:grid-cols-5 gap-3 items-end">
        <label className="space-y-1">
          <span className="text-xs text-slate-400">Period</span>
          <input type="month" name="period" className="input" defaultValue={range.period} />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-slate-400">Pipeline</span>
          <select name="pipeline" className="input" defaultValue={pipelineId ?? ""}>
            <option value="">All pipelines</option>
            {pipelines.map((pipeline) => <option key={pipeline.id} value={pipeline.id}>{pipeline.name}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-slate-400">Team</span>
          <select name="team" className="input" defaultValue={teamId ?? ""}>
            <option value="">All accessible teams</option>
            {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-slate-400">Owner</span>
          <select name="user" className="input" defaultValue={ownerId ?? ""}>
            <option value="">All accessible owners</option>
            {users.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <button className="btn-primary">Apply</button>
      </form>

      <KpiGrid className="md:grid-cols-3 xl:grid-cols-6">
        {[
          { label: "Open", value: formatZARCompact(summary.openValueCents), icon: CircleDollarSign },
          { label: "Weighted", value: formatZARCompact(summary.weightedValueCents), icon: Calculator },
          { label: "Commit", value: formatZARCompact(summary.commitValueCents), icon: Crosshair },
          { label: "Best case", value: formatZARCompact(summary.bestCaseValueCents), icon: HandCoins },
          { label: "Pipeline", value: formatZARCompact(summary.pipelineValueCents), icon: Layers3 },
          { label: "Deals", value: String(summary.count), icon: BadgeDollarSign },
        ].map(({ label, value, icon }) => (
          <MetricCard key={label} icon={icon} label={label} value={value} />
        ))}
      </KpiGrid>

      <div className="card p-0 overflow-x-auto">
        <table className="table-base">
          <thead>
            <tr>
              <th>Lead</th><th>Pipeline / stage</th><th>Owner</th><th>Close</th>
              <th>Category</th><th>Probability</th><th className="text-right">Value</th>
              <th className="text-right">Weighted</th><th>Edit</th>
            </tr>
          </thead>
          <tbody>
            {leads.length === 0 && (
              <tr><td colSpan={9} className="text-center py-8 text-slate-400">No accessible open leads match this forecast period.</td></tr>
            )}
            {leads.map((lead) => (
              <tr key={lead.id}>
                <td>
                  <Link href={`/leads/${lead.id}`} className="text-orange-400 font-medium hover:underline">{lead.title}</Link>
                  <p className="text-xs text-slate-500">{lead.name}</p>
                </td>
                <td>{lead.pipelineName}<p className="text-xs text-slate-500">{lead.stageName}</p></td>
                <td>{lead.assignedToName ?? "Unassigned"}<p className="text-xs text-slate-500">{lead.teamName ?? "No team"}</p></td>
                <td>{formatDate(lead.expectedCloseDate)}</td>
                <td>{lead.forecastCategory.replace("_", " ")}</td>
                <td>{lead.probability}%</td>
                <td className="text-right">{formatZAR(lead.valueCents)}</td>
                <td className="text-right">{formatZAR(Math.round(lead.valueCents * lead.probability / 100))}</td>
                <td>
                  {canManage && (
                    <details>
                      <summary className="cursor-pointer text-orange-400 text-xs">Edit</summary>
                      <form action={saveLeadForecast.bind(null, lead.id)} className="space-y-2 mt-2 min-w-52">
                        <input name="probability" type="number" min="0" max="100" className="input" defaultValue={lead.probability} />
                        <select name="forecastCategory" className="input" defaultValue={lead.forecastCategory}>
                          <option value="pipeline">Pipeline</option>
                          <option value="best_case">Best case</option>
                          <option value="commit">Commit</option>
                          <option value="omitted">Omitted</option>
                        </select>
                        <input name="expectedCloseDate" type="date" className="input" defaultValue={lead.expectedCloseDate?.toISOString().slice(0, 10) ?? ""} />
                        <input name="estimatedCost" className="input" placeholder="Estimated cost (R)" defaultValue={lead.estimatedCostCents != null ? lead.estimatedCostCents / 100 : ""} />
                        {canAssign ? (
                          <select name="teamId" className="input" defaultValue={lead.teamId ?? ""}>
                            <option value="">No team</option>
                            {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
                          </select>
                        ) : (
                          <input type="hidden" name="teamId" value={lead.teamId ?? ""} />
                        )}
                        <button className="btn-primary btn-sm">Save</button>
                      </form>
                    </details>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 className="font-semibold mb-4">Recent accessible snapshots</h2>
        {snapshots.length === 0 ? (
          <p className="text-sm text-slate-400">No snapshots yet.</p>
        ) : (
          <ul className="divide-y divide-slate-800">
            {snapshots.map((snapshot) => (
              <li key={snapshot.id} className="py-2 text-sm flex gap-3">
                <div className="flex-1">
                  <p>
                    {snapshot.period} · {snapshot.pipelineName ?? "All pipelines"} · {snapshot.teamName ?? "All teams"} · {snapshot.userName ?? "All owners"}
                  </p>
                  <p className="text-xs text-slate-500">
                    Open {formatZAR(Number(snapshot.openValueCents))} · Weighted {formatZAR(Number(snapshot.weightedValueCents))} · {snapshot.opportunityCount} deals · {formatDateTime(snapshot.capturedAt)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
