import Link from "next/link";
import { BarChart3, CalendarDays, GitBranch, MessagesSquare, Radio, Sparkles, UserRound } from "lucide-react";
import { requireOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getBotFlowAnalyticsReport, type FlowTrendPoint } from "@/lib/botFlowAnalyticsReport";
import { BOT_ANALYTICS_CHANNELS, BOT_ANALYTICS_RANGES } from "@/lib/botFlowAnalyticsFilters";
import { WorkspaceHero } from "@/components/workspace-hero";
import { EmptyState, StatusPill, Surface } from "@/components/visual-system";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";
import { flowScope } from "@/lib/flowScope";

const pct = (part: number, total: number) => total > 0 ? `${Math.round((part / total) * 1000) / 10}%` : "—";
const channelLabel = (channel: string) => channel === "whatsapp" ? "WhatsApp" : channel === "instagram" ? "Instagram" : channel === "messenger" ? "Messenger" : channel === "telegram" ? "Telegram" : channel;
const shortDate = (value: string | Date) => new Date(value).toLocaleDateString("en-ZA", { day: "numeric", month: "short", timeZone: "UTC" });

type Search = { flowId?: string; range?: string; channel?: string; version?: string };

export default async function BotAnalyticsPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requireOwner();
  const params = await searchParams;
  const scope = await flowScope();
  const flows = await prisma.botFlow.findMany({
    where: scope,
    select: { id: true, name: true, active: true, updatedAt: true },
    orderBy: [{ active: "desc" }, { updatedAt: "desc" }],
  });
  const selected = flows.find((flow) => flow.id === params.flowId) ?? flows[0] ?? null;
  const report = selected ? await getBotFlowAnalyticsReport(selected.id, params) : null;
  const scopeLabel = report
    ? `Version ${report.selectedVersion?.version ?? "—"} · last ${report.filters.rangeDays} days${report.filters.channel ? ` · ${channelLabel(report.filters.channel)}` : ""}`
    : "";

  return (
    <div className="space-y-5">
      <WorkspaceHero
        icon={BarChart3}
        eyebrow="Conversation performance"
        title="Chatbot analytics"
        description="Compare published flow versions, inspect daily performance and node drop-off, and see which CRM outcomes each conversation creates."
        stats={report ? [
          { label: "Flow runs", value: report.summary.started, icon: MessagesSquare },
          { label: "Completed", value: pct(report.summary.completed, report.summary.started), icon: Radio, tone: "success" },
          { label: "Handed off", value: pct(report.summary.handedOff, report.summary.started), icon: UserRound },
          { label: "CRM outcomes", value: report.actions.reduce((total, action) => total + action.count, 0), icon: Sparkles },
        ] : []}
        actions={<Link href="/bot-builder" className="btn-secondary btn-sm"><GitBranch className="size-4" />Flow builder</Link>}
      />

      {flows.length > 0 && (
        <Surface className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Flow</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {flows.map((flow) => (
              <Link
                key={flow.id}
                href={`/bot-analytics?flowId=${encodeURIComponent(flow.id)}&range=${report?.filters.rangeDays ?? 30}`}
                className={flow.id === selected?.id ? "btn-primary btn-sm" : "btn-secondary btn-sm"}
              >
                {flow.name}{flow.active ? " · live" : ""}
              </Link>
            ))}
          </div>
        </Surface>
      )}

      {!selected || !report ? (
        <EmptyState icon={BarChart3} title="No flows to analyse" description="Create and publish a chatbot flow first." />
      ) : (
        <>
          <Surface className="p-4">
            <form method="get" className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_180px_auto] md:items-end">
              <input type="hidden" name="flowId" value={selected.id} />
              <label>
                <span className="label">Published version</span>
                <select name="version" className="input" defaultValue={report.selectedVersion?.id ?? ""}>
                  {report.versions.map((version) => (
                    <option key={version.id} value={version.id}>Version {version.version} · {version.publishedAt.toLocaleDateString("en-ZA")}</option>
                  ))}
                </select>
              </label>
              <label>
                <span className="label">Channel</span>
                <select name="channel" className="input" defaultValue={report.filters.channel ?? ""}>
                  <option value="">All channels</option>
                  {BOT_ANALYTICS_CHANNELS.map((channel) => <option key={channel} value={channel}>{channelLabel(channel)}</option>)}
                </select>
              </label>
              <label>
                <span className="label">Date range</span>
                <select name="range" className="input" defaultValue={String(report.filters.rangeDays)}>
                  {BOT_ANALYTICS_RANGES.map((days) => <option key={days} value={days}>Last {days} days</option>)}
                </select>
              </label>
              <button type="submit" className="btn-primary h-10"><CalendarDays className="size-4" />Apply filters</button>
            </form>
            <p className="mt-3 text-xs text-muted-foreground">Showing {scopeLabel}. Date boundaries use UTC calendar days.</p>
          </Surface>

          <div className="grid gap-4 lg:grid-cols-2">
            <Surface className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Selected published version</p>
                  <h2 className="mt-1 text-lg font-semibold">{selected.name}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {report.selectedVersion ? `Version ${report.selectedVersion.version} · published ${report.selectedVersion.publishedAt.toLocaleDateString("en-ZA")}` : "No immutable published version yet"}
                  </p>
                </div>
                {selected.active && <StatusPill tone="success">Live flow</StatusPill>}
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <Metric label="Flow runs" value={String(report.summary.started)} />
                <Metric label="Completed" value={`${report.summary.completed} · ${pct(report.summary.completed, report.summary.started)}`} />
                <Metric label="Handed off" value={`${report.summary.handedOff} · ${pct(report.summary.handedOff, report.summary.started)}`} />
                <Metric label="Delivery failures" value={String(report.summary.deliveryFailures)} />
              </div>
              <p className="mt-3 text-xs text-muted-foreground">{report.allTime.started} run{report.allTime.started === 1 ? "" : "s"} across every version and all time.</p>
              <div className="mt-3"><Link href={`/bot-builder/${selected.id}`} className="text-xs text-orange-400 hover:underline">Open this flow draft →</Link></div>
            </Surface>

            <Surface className="p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Channel performance</p>
              <div className="mt-3 space-y-2">
                {report.channels.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No runs match the selected filters.</p>
                ) : report.channels.map((channel) => (
                  <div key={channel.channel} className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-3 rounded-xl border border-border bg-muted/30 px-3 py-2.5">
                    <div><p className="text-sm font-medium">{channelLabel(channel.channel)}</p><p className="text-[10px] text-muted-foreground">{channel.conversations} run{channel.conversations === 1 ? "" : "s"}</p></div>
                    <Rate label="complete" value={pct(channel.completed, channel.conversations)} tone="text-emerald-300" />
                    <Rate label="handoff" value={pct(channel.handedOff, channel.conversations)} tone="text-amber-300" />
                    <Rate label="CRM" value={String(channel.crmActions)} tone="text-sky-300" />
                  </div>
                ))}
              </div>
            </Surface>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,0.5fr)]">
            <Surface className="p-5">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Daily trend</p>
                  <p className="mt-1 text-sm text-muted-foreground">Starts and completions for the selected version and channel.</p>
                </div>
                <div className="flex gap-3 text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-orange-400" />Started</span>
                  <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-emerald-400" />Completed</span>
                </div>
              </div>
              <TrendChart points={report.trend} />
              <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
                <span>{report.trend.reduce((sum, day) => sum + day.handedOff, 0)} handoffs</span>
                <span>{report.trend.reduce((sum, day) => sum + day.crmActions, 0)} CRM outcomes</span>
              </div>
            </Surface>

            <Surface className="p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">CRM outcomes</p>
              <p className="mt-1 text-sm text-muted-foreground">Successful actions, not button clicks or attempted writes.</p>
              <div className="mt-4 space-y-2">
                {report.actions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No successful CRM actions match the filters.</p>
                ) : report.actions.map((action) => (
                  <div key={action.action} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/30 px-3 py-2.5">
                    <div><p className="text-sm font-medium">{action.label}</p><p className="font-mono text-[10px] text-muted-foreground">{action.action}</p></div>
                    <span className="text-lg font-semibold">{action.count}</span>
                  </div>
                ))}
              </div>
            </Surface>
          </div>

          <Surface className="overflow-hidden">
            <div className="border-b border-border px-5 py-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Version comparison</p>
              <p className="mt-1 text-sm text-muted-foreground">Every published version in the selected date range{report.filters.channel ? ` for ${channelLabel(report.filters.channel)}` : ""}. Zero-activity versions remain visible.</p>
            </div>
            <ResponsiveEntityTable className="rounded-none border-0 bg-transparent">
              <table className="table-base w-full min-w-[780px] text-left text-sm">
                <thead className="bg-muted/35 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr><th className="px-5 py-3">Version</th><th className="px-3 py-3 text-right">Runs</th><th className="px-3 py-3 text-right">Completed</th><th className="px-3 py-3 text-right">Handoff</th><th className="px-3 py-3 text-right">CRM outcomes</th><th className="px-5 py-3 text-right">Delivery failures</th></tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {report.versionPerformance.map((version) => (
                    <tr key={version.id} className={version.id === report.selectedVersion?.id ? "bg-orange-500/5" : "hover:bg-muted/20"}>
                      <td data-primary className="px-5 py-3"><p className="font-medium">Version {version.version}{version.id === report.selectedVersion?.id ? " · selected" : ""}</p><p className="text-[10px] text-muted-foreground">{version.publishedAt.toLocaleDateString("en-ZA")}</p></td>
                      <td data-label="Runs" className="px-3 py-3 text-right font-medium">{version.started}</td>
                      <td data-label="Completed" className="px-3 py-3 text-right">{version.completed} · {pct(version.completed, version.started)}</td>
                      <td data-label="Handoff" className="px-3 py-3 text-right">{version.handedOff} · {pct(version.handedOff, version.started)}</td>
                      <td data-label="CRM outcomes" className="px-3 py-3 text-right">{version.crmActions}</td>
                      <td data-label="Delivery failures" className="px-5 py-3 text-right">{version.deliveryFailures}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ResponsiveEntityTable>
          </Surface>

          <Surface className="overflow-hidden">
            <div className="border-b border-border px-5 py-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Selected-version funnel</p>
              <p className="mt-1 text-sm text-muted-foreground">Reach is a recorded visit to a waiting node. Progress and drop-off apply to menus, captures and slot selection; successful CRM and Journey effects are counted separately.</p>
            </div>
            {report.nodes.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">No node-level activity has been recorded for this version and filter range.</div>
            ) : (
              <ResponsiveEntityTable className="rounded-none border-0 bg-transparent">
                <table className="table-base w-full min-w-[980px] text-left text-sm">
                  <thead className="bg-muted/35 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <tr><th className="px-5 py-3">Node</th><th className="px-3 py-3">Type</th><th className="px-3 py-3 text-right">Reached</th><th className="px-3 py-3 text-right">Progressed</th><th className="px-3 py-3 text-right">Rate</th><th className="px-3 py-3 text-right">Drop-off</th><th className="px-3 py-3 text-right">CRM actions</th><th className="px-3 py-3 text-right">Handoffs</th><th className="px-5 py-3 text-right">Delivery failures</th></tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {report.nodes.map((node) => (
                      <tr key={node.nodeId} className="hover:bg-muted/20">
                        <td data-primary className="px-5 py-3"><p className="max-w-md font-medium text-foreground">{node.label}</p><p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{node.nodeId}</p></td>
                        <td data-label="Type" className="px-3 py-3 text-xs text-muted-foreground">{node.type}</td>
                        <td data-label="Reached" className="px-3 py-3 text-right font-medium">{node.reached}</td>
                        <td data-label="Progressed" className="px-3 py-3 text-right">{node.interacted ?? "—"}</td>
                        <td data-label="Rate" className="px-3 py-3 text-right">{node.progressionRate == null ? "—" : `${node.progressionRate}%`}</td>
                        <td data-label="Drop-off" className="px-3 py-3 text-right">{node.dropOff ?? "—"}</td>
                        <td data-label="CRM actions" className="px-3 py-3 text-right">{node.crmActions}</td>
                        <td data-label="Handoffs" className="px-3 py-3 text-right">{node.handoffs}</td>
                        <td data-label="Delivery failures" className="px-5 py-3 text-right">{node.deliveryFailures}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ResponsiveEntityTable>
            )}
          </Surface>

          <p className="text-xs leading-5 text-muted-foreground">
            Run totals include both stateful guided conversations and automatic one-shot graphs. A deliberate restart creates a new flow run. Delivery failures appear only after an outbox message becomes terminally dead. Analytics stores bounded event metadata, not conversation transcripts.
          </p>
        </>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-border bg-muted/30 p-3"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-1 text-lg font-semibold">{value}</p></div>;
}

function Rate({ label, value, tone }: { label: string; value: string; tone: string }) {
  return <div className="text-right"><p className={`text-xs font-medium ${tone}`}>{value}</p><p className="text-[10px] text-muted-foreground">{label}</p></div>;
}

function TrendChart({ points }: { points: FlowTrendPoint[] }) {
  const max = Math.max(1, ...points.flatMap((point) => [point.started, point.completed]));
  const width = Math.max(640, points.length * 18);
  return (
    <div className="mt-5 overflow-x-auto pb-1">
      <div className="flex h-48 items-end gap-1 border-b border-border" style={{ minWidth: width }} role="img" aria-label="Daily flow starts and completions">
        {points.map((point, index) => (
          <div key={point.day} className="group relative flex h-full min-w-3 flex-1 items-end justify-center gap-px" title={`${shortDate(point.day)}: ${point.started} started, ${point.completed} completed, ${point.handedOff} handed off, ${point.crmActions} CRM outcomes`}>
            <span className="sr-only">{shortDate(point.day)}: {point.started} started and {point.completed} completed.</span>
            <span className="w-[42%] min-w-1 rounded-t bg-orange-400/80" style={{ height: `${Math.max(point.started ? 4 : 0, (point.started / max) * 100)}%` }} />
            <span className="w-[42%] min-w-1 rounded-t bg-emerald-400/80" style={{ height: `${Math.max(point.completed ? 4 : 0, (point.completed / max) * 100)}%` }} />
            {(index === 0 || index === points.length - 1 || (points.length <= 7 && index % 2 === 0)) && (
              <span className="absolute top-full mt-1 whitespace-nowrap text-[9px] text-muted-foreground">{shortDate(point.day)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
