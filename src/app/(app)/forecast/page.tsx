import Link from "next/link";
import { Calculator, Crosshair, HandCoins, Layers3, SlidersHorizontal, TrendingUp, History } from "lucide-react";
import { basePrisma } from "@/lib/db";
import { formatDate, formatDateTime, formatZAR, formatZARCompact } from "@/lib/format";
import { getAccessibleLeadScope, hasPermission, requirePermission } from "@/lib/permissions";
import { listActiveSalesPipelines, listForecastLeads, summarizeForecast } from "@/lib/pipelines";
import { saveLeadForecast, snapshotForecast } from "@/app/actions/pipelines";
import { EmptyState, SectionHeading, StatusPill, Surface } from "@/components/visual-system";
import { WorkspaceHero } from "@/components/workspace-hero";

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
      <WorkspaceHero
        icon={TrendingUp}
        eyebrow="Revenue planning"
        title="Sales forecast"
        description={`Pipeline confidence and expected revenue for ${range.from.toLocaleDateString("en-ZA", { month: "long", year: "numeric", timeZone: "UTC" })}.`}
        stats={[
          { label: "Open pipeline", value: formatZARCompact(summary.openValueCents), detail: `${summary.count} opportunities` },
          { label: "Weighted forecast", value: formatZARCompact(summary.weightedValueCents), detail: summary.openValueCents ? `${Math.round(summary.weightedValueCents / summary.openValueCents * 100)}% of open value` : "No open value", tone: "primary" },
          { label: "Committed", value: formatZARCompact(summary.commitValueCents), detail: "Highest-confidence revenue", tone: "success" },
          { label: "Best case", value: formatZARCompact(summary.bestCaseValueCents), detail: "Upside potential", tone: "warning" },
        ]}
        actions={<>
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
        </>}
      />

      <Surface className="p-4 sm:p-5">
        <div className="mb-4 flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-muted/40 text-muted-foreground"><SlidersHorizontal className="size-4" /></span>
          <div><h2 className="font-semibold tracking-tight">Forecast scope</h2><p className="mt-0.5 text-xs text-muted-foreground">Focus the model by period, pipeline, team or owner.</p></div>
        </div>
        <form className="grid gap-3 md:grid-cols-5 md:items-end">
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
          <button className="btn-primary">Apply filters</button>
        </form>
      </Surface>

      <Surface className="p-5">
        <SectionHeading title="Forecast composition" description="How open opportunity value is classified by the sales team." />
        <div className="mt-5 flex h-3 overflow-hidden rounded-full bg-muted/70" aria-label="Forecast category distribution">
          {(() => {
            const total = summary.commitValueCents + summary.bestCaseValueCents + summary.pipelineValueCents;
            if (!total) return <div className="h-full w-full bg-muted" />;
            return <>
              <div className="h-full bg-emerald-400" style={{ width: `${summary.commitValueCents / total * 100}%` }} />
              <div className="h-full bg-amber-400" style={{ width: `${summary.bestCaseValueCents / total * 100}%` }} />
              <div className="h-full bg-sky-400" style={{ width: `${summary.pipelineValueCents / total * 100}%` }} />
            </>;
          })()}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { label: "Commit", value: summary.commitValueCents, icon: Crosshair, color: "bg-emerald-400", detail: "Expected to close" },
            { label: "Best case", value: summary.bestCaseValueCents, icon: HandCoins, color: "bg-amber-400", detail: "Credible upside" },
            { label: "Pipeline", value: summary.pipelineValueCents, icon: Layers3, color: "bg-sky-400", detail: "Still developing" },
            { label: "Weighted", value: summary.weightedValueCents, icon: Calculator, color: "bg-primary", detail: `${summary.count} open deal${summary.count === 1 ? "" : "s"}` },
          ].map(({ label, value, icon: Icon, color, detail }) => (
            <div key={label} className="rounded-xl border border-border/70 bg-muted/[0.18] p-3.5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground"><span className={`size-2 rounded-full ${color}`} /><Icon className="size-3.5" />{label}</div>
              <p className="mt-2 text-lg font-semibold tracking-[-0.03em] tabular-nums">{formatZARCompact(value)}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{detail}</p>
            </div>
          ))}
        </div>
      </Surface>

      <Surface>
        <div className="border-b border-border/70 px-5 py-4"><SectionHeading title="Opportunity forecast" description="Review value, confidence and close timing for every deal in scope." /></div>
        <div className="overflow-x-auto">
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
                <td><StatusPill tone={lead.forecastCategory === "commit" ? "success" : lead.forecastCategory === "best_case" ? "warning" : lead.forecastCategory === "omitted" ? "neutral" : "info"}>{lead.forecastCategory.replace("_", " ")}</StatusPill></td>
                <td><div className="min-w-20"><span className="text-xs tabular-nums">{lead.probability}%</span><div className="mt-1 h-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${lead.probability}%` }} /></div></div></td>
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
      </Surface>

      <Surface className="p-5">
        <SectionHeading title="Forecast history" description="Point-in-time snapshots show how confidence changes through the month." />
        {snapshots.length === 0 ? (
          <EmptyState icon={History} title="No snapshots yet" description="Capture the current forecast to create a baseline for later comparison." className="mt-4 py-8" />
        ) : (
          <ul className="mt-4 grid gap-2 md:grid-cols-2">
            {snapshots.map((snapshot) => (
              <li key={snapshot.id} className="rounded-xl border border-border/70 bg-muted/[0.16] p-3 text-sm">
                <div className="flex-1">
                  <p>
                    {snapshot.period} · {snapshot.pipelineName ?? "All pipelines"} · {snapshot.teamName ?? "All teams"} · {snapshot.userName ?? "All owners"}
                  </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                    Open {formatZAR(Number(snapshot.openValueCents))} · Weighted {formatZAR(Number(snapshot.weightedValueCents))} · {snapshot.opportunityCount} deals · {formatDateTime(snapshot.capturedAt)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Surface>
    </div>
  );
}
