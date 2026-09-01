import Link from "next/link";
import {
  AlertTriangle,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  GitBranch,
  MessagesSquare,
  Radio,
  Sparkles,
  UserRound,
} from "lucide-react";
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
const shortDate = (value: string | Date) => new Date(value).toLocaleDateString("en-ZA", { day: "numeric", month: "short", timeZone: "Africa/Johannesburg" });

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
    ? `${report.selectedVersion ? `Version ${report.selectedVersion.version}` : "All versions"} · last ${report.filters.rangeDays} days${report.filters.channel ? ` · ${channelLabel(report.filters.channel)}` : ""}`
    : "";

  const attentionNodes = report?.nodes
    .filter((node) => node.handoffs > 0 || node.deliveryFailures > 0)
    .sort((a, b) => (b.deliveryFailures + b.handoffs) - (a.deliveryFailures + a.handoffs))
    .slice(0, 5) ?? [];

  return (
    <div className="min-w-0 space-y-5">
      <WorkspaceHero
        icon={BarChart3}
        eyebrow="Conversation performance"
        title="Chatbot analytics"
        description="Understand what customers experience, where conversations stop, and which published versions create the strongest outcomes."
        stats={report ? [
          { label: "Flow runs", value: report.summary.started, icon: MessagesSquare },
          { label: "Completed", value: pct(report.summary.completed, report.summary.started), icon: Radio, tone: "success" },
          { label: "Handed off", value: pct(report.summary.handedOff, report.summary.started), icon: UserRound },
          { label: "CRM outcomes", value: report.actions.reduce((total, action) => total + action.count, 0), icon: Sparkles },
        ] : []}
        actions={<Link href="/bot-builder" className="btn-secondary btn-sm min-h-11"><GitBranch className="size-4" aria-hidden="true" />Flow builder</Link>}
      />

      {flows.length > 0 && (
        <Surface className="min-w-0 p-4">
          <p id="analytics-flow-label" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Flow</p>
          <nav aria-labelledby="analytics-flow-label" className="mt-2 flex min-w-0 flex-wrap gap-2">
            {flows.map((flow) => (
              <Link
                key={flow.id}
                href={`/bot-analytics?flowId=${encodeURIComponent(flow.id)}&range=${report?.filters.rangeDays ?? 30}${report?.filters.channel ? `&channel=${encodeURIComponent(report.filters.channel)}` : ""}`}
                aria-current={flow.id === selected?.id ? "page" : undefined}
                className={`${flow.id === selected?.id ? "btn-primary" : "btn-secondary"} btn-sm min-h-11 max-w-full whitespace-normal text-left`}
              >
                {flow.name}{flow.active ? " · live" : ""}
              </Link>
            ))}
          </nav>
        </Surface>
      )}

      {!selected || !report ? (
        <EmptyState icon={BarChart3} title="No flows to analyse" description="Create and publish a chatbot flow first." />
      ) : (
        <>
          <Surface className="min-w-0 p-4">
            <form method="get" aria-label="Analytics filters" className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_180px_180px_auto] md:items-end">
              <input type="hidden" name="flowId" value={selected.id} />
              <label className="min-w-0">
                <span className="label">Published version</span>
                <select name="version" className="input min-h-11 w-full" defaultValue={report.selectedVersion?.id ?? ""}>
                  <option value="">All versions</option>
                  {report.versions.map((version) => (
                    <option key={version.id} value={version.id}>Version {version.version} · {shortDate(version.publishedAt)}</option>
                  ))}
                </select>
              </label>
              <label>
                <span className="label">Channel</span>
                <select name="channel" className="input min-h-11 w-full" defaultValue={report.filters.channel ?? ""}>
                  <option value="">All channels</option>
                  {BOT_ANALYTICS_CHANNELS.map((channel) => <option key={channel} value={channel}>{channelLabel(channel)}</option>)}
                </select>
              </label>
              <label>
                <span className="label">Date range</span>
                <select name="range" className="input min-h-11 w-full" defaultValue={String(report.filters.rangeDays)}>
                  {BOT_ANALYTICS_RANGES.map((days) => <option key={days} value={days}>Last {days} days</option>)}
                </select>
              </label>
              <button type="submit" className="btn-primary min-h-11"><CalendarDays className="size-4" aria-hidden="true" />Apply filters</button>
            </form>
            <p className="mt-3 text-xs text-muted-foreground" aria-live="polite">Showing {scopeLabel}. Date boundaries use South African calendar days.</p>
          </Surface>

          <section aria-labelledby="analytics-overview-heading" className="min-w-0 space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Performance overview</p>
                <h2 id="analytics-overview-heading" className="mt-1 text-xl font-semibold">{selected.name}</h2>
              </div>
              {selected.active && <StatusPill tone="success">Live flow</StatusPill>}
            </div>

            <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="Flow runs" value={String(report.summary.started)} detail={`${report.allTime.started} all-time`} />
              <Metric label="Completed" value={pct(report.summary.completed, report.summary.started)} detail={`${report.summary.completed} conversations`} tone="success" />
              <Metric label="Human handoff" value={pct(report.summary.handedOff, report.summary.started)} detail={`${report.summary.handedOff} conversations`} tone={report.summary.handedOff > 0 ? "warning" : "neutral"} />
              <Metric label="Delivery failures" value={String(report.summary.deliveryFailures)} detail={report.summary.deliveryFailures > 0 ? "Needs attention" : "No terminal failures"} tone={report.summary.deliveryFailures > 0 ? "danger" : "success"} />
            </div>

            <Surface className="min-w-0 p-5">
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Published context</p>
                  <p className="mt-1 break-words text-sm text-foreground">
                    {report.selectedVersion ? `Version ${report.selectedVersion.version} · published ${shortDate(report.selectedVersion.publishedAt)}` : "All immutable published versions"}
                  </p>
                </div>
                <Link href={`/bot-builder/${selected.id}`} className="btn-secondary btn-sm min-h-11">Open flow draft</Link>
              </div>
            </Surface>
          </section>

          <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(280px,0.55fr)]">
            <Surface className="min-w-0 p-5">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Daily trend</p>
                  <h2 className="mt-1 text-lg font-semibold">Conversation volume and completion</h2>
                  <p className="mt-1 text-sm text-muted-foreground">Starts and completions for the selected version and channel.</p>
                </div>
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground" aria-hidden="true">
                  <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-orange-400" />Started</span>
                  <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-emerald-400" />Completed</span>
                </div>
              </div>
              <TrendChart points={report.trend} />
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <InlineStat label="Handoffs" value={report.trend.reduce((sum, day) => sum + day.handedOff, 0)} />
                <InlineStat label="CRM outcomes" value={report.trend.reduce((sum, day) => sum + day.crmActions, 0)} />
              </div>
            </Surface>

            <Surface className="min-w-0 p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">CRM outcomes</p>
              <h2 className="mt-1 text-lg font-semibold">Successful downstream actions</h2>
              <p className="mt-1 text-sm text-muted-foreground">Successful persisted actions, not clicks or attempted writes.</p>
              <div className="mt-4 space-y-2">
                {report.actions.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">No successful CRM actions match the current filters.</p>
                ) : report.actions.map((action) => (
                  <div key={action.action} className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-border bg-muted/30 px-3 py-3">
                    <div className="min-w-0"><p className="truncate text-sm font-medium">{action.label}</p><p className="truncate font-mono text-[10px] text-muted-foreground">{action.action}</p></div>
                    <span className="shrink-0 text-lg font-semibold">{action.count}</span>
                  </div>
                ))}
              </div>
            </Surface>
          </div>

          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            <Surface className="min-w-0 p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Channel performance</p>
              <h2 className="mt-1 text-lg font-semibold">Where conversations perform</h2>
              <div className="mt-4 space-y-2">
                {report.channels.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">No runs match the selected filters.</p>
                ) : report.channels.map((channel) => (
                  <div key={channel.channel} className="grid min-w-0 grid-cols-2 gap-3 rounded-xl border border-border bg-muted/30 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-center">
                    <div className="col-span-2 min-w-0 sm:col-span-1"><p className="text-sm font-medium">{channelLabel(channel.channel)}</p><p className="text-[10px] text-muted-foreground">{channel.conversations} run{channel.conversations === 1 ? "" : "s"}</p></div>
                    <Rate label="Complete" value={pct(channel.completed, channel.conversations)} />
                    <Rate label="Handoff" value={pct(channel.handedOff, channel.conversations)} />
                    <Rate label="CRM" value={String(channel.crmActions)} />
                  </div>
                ))}
              </div>
            </Surface>

            <Surface className="min-w-0 p-5">
              <div className="flex items-start gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-amber-500/20 bg-amber-500/10 text-amber-300"><AlertTriangle className="size-5" aria-hidden="true" /></span>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Needs attention</p>
                  <h2 className="mt-1 text-lg font-semibold">Handoffs and delivery failures</h2>
                </div>
              </div>
              {attentionNodes.length === 0 ? (
                <div className="mt-4 flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 text-sm"><CheckCircle2 className="size-4 shrink-0 text-emerald-300" aria-hidden="true" />No node-level handoffs or delivery failures in this view.</div>
              ) : (
                <ul className="mt-4 space-y-2">
                  {attentionNodes.map((node) => (
                    <li key={node.nodeId} className="rounded-xl border border-border bg-muted/30 p-3">
                      <p className="break-words text-sm font-medium">{node.label}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{node.handoffs} handoff{node.handoffs === 1 ? "" : "s"} · {node.deliveryFailures} delivery failure{node.deliveryFailures === 1 ? "" : "s"}</p>
                    </li>
                  ))}
                </ul>
              )}
            </Surface>
          </div>

          <Surface className="min-w-0 overflow-hidden">
            <div className="border-b border-border px-4 py-4 sm:px-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Version comparison</p>
              <h2 className="mt-1 text-lg font-semibold">Published version performance</h2>
              <p className="mt-1 text-sm text-muted-foreground">Every published version in the selected date range{report.filters.channel ? ` for ${channelLabel(report.filters.channel)}` : ""}. Zero-activity versions remain visible.</p>
            </div>
            <ResponsiveEntityTable className="rounded-none border-0 bg-transparent">
              <table className="table-base w-full min-w-[780px] text-left text-sm">
                <caption className="sr-only">Published Flowbot versions compared by runs, completion, handoff, CRM outcomes and delivery failures.</caption>
                <thead className="bg-muted/35 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr><th scope="col" className="px-5 py-3">Version</th><th scope="col" className="px-3 py-3 text-right">Runs</th><th scope="col" className="px-3 py-3 text-right">Completed</th><th scope="col" className="px-3 py-3 text-right">Handoff</th><th scope="col" className="px-3 py-3 text-right">CRM outcomes</th><th scope="col" className="px-5 py-3 text-right">Delivery failures</th></tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {report.versionPerformance.map((version) => (
                    <tr key={version.id} className={version.id === report.selectedVersion?.id ? "bg-orange-500/5" : "hover:bg-muted/20"}>
                      <td data-primary className="px-5 py-3"><p className="font-medium">Version {version.version}{version.id === report.selectedVersion?.id ? " · selected" : ""}</p><p className="text-[10px] text-muted-foreground">{shortDate(version.publishedAt)}</p></td>
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

          <Surface className="min-w-0 overflow-hidden">
            <div className="border-b border-border px-4 py-4 sm:px-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Selected-version funnel</p>
              <h2 className="mt-1 text-lg font-semibold">Where conversations progress or stop</h2>
              <p className="mt-1 text-sm text-muted-foreground">Reach is a recorded visit to a waiting node. Progress and drop-off apply to menus, captures and slot selection; successful CRM and Journey effects are counted separately.</p>
            </div>
            {report.nodes.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">No node-level activity has been recorded for this version and filter range.</div>
            ) : (
              <ResponsiveEntityTable className="rounded-none border-0 bg-transparent">
                <table className="table-base w-full min-w-[980px] text-left text-sm">
                  <caption className="sr-only">Node funnel showing reach, progression, drop-off, CRM actions, handoffs and delivery failures.</caption>
                  <thead className="bg-muted/35 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <tr><th scope="col" className="px-5 py-3">Node</th><th scope="col" className="px-3 py-3">Type</th><th scope="col" className="px-3 py-3 text-right">Reached</th><th scope="col" className="px-3 py-3 text-right">Progressed</th><th scope="col" className="px-3 py-3 text-right">Rate</th><th scope="col" className="px-3 py-3 text-right">Drop-off</th><th scope="col" className="px-3 py-3 text-right">CRM actions</th><th scope="col" className="px-3 py-3 text-right">Handoffs</th><th scope="col" className="px-5 py-3 text-right">Delivery failures</th></tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {report.nodes.map((node) => (
                      <tr key={node.nodeId} className="hover:bg-muted/20">
                        <td data-primary className="px-5 py-3"><p className="max-w-md font-medium text-foreground">{node.label}</p><p className="mt-0.5 break-all font-mono text-[10px] text-muted-foreground">{node.nodeId}</p></td>
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

function Metric({ label, value, detail, tone = "neutral" }: { label: string; value: string; detail: string; tone?: "neutral" | "success" | "warning" | "danger" }) {
  const toneClass = tone === "success" ? "text-emerald-300" : tone === "warning" ? "text-amber-300" : tone === "danger" ? "text-rose-300" : "text-foreground";
  return (
    <Surface className="min-w-0 p-4">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${toneClass}`}>{value}</p>
      <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p>
    </Surface>
  );
}

function InlineStat({ label, value }: { label: string; value: number }) {
  return <div className="rounded-xl border border-border bg-muted/30 px-3 py-2.5"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-0.5 text-base font-semibold">{value}</p></div>;
}

function Rate({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 sm:text-right"><p className="text-sm font-semibold text-foreground">{value}</p><p className="text-[10px] text-muted-foreground">{label}</p></div>;
}

function TrendChart({ points }: { points: FlowTrendPoint[] }) {
  const max = Math.max(1, ...points.flatMap((point) => [point.started, point.completed]));
  const width = Math.max(640, points.length * 18);
  const started = points.reduce((sum, point) => sum + point.started, 0);
  const completed = points.reduce((sum, point) => sum + point.completed, 0);

  if (points.length === 0) {
    return <div className="mt-5 rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No daily activity matches the current filters.</div>;
  }

  return (
    <div className="mt-5 max-w-full overflow-x-auto overscroll-x-contain pb-5" tabIndex={0} aria-label="Scrollable daily analytics chart">
      <div className="sr-only">Daily trend: {started} starts and {completed} completions across {points.length} days.</div>
      <div className="flex h-48 items-end gap-1 border-b border-border" style={{ minWidth: width }} role="img" aria-label={`Daily flow trend with ${started} starts and ${completed} completions`}>
        {points.map((point, index) => (
          <div key={point.day} className="group relative flex h-full min-w-3 flex-1 items-end justify-center gap-px" title={`${shortDate(point.day)}: ${point.started} started, ${point.completed} completed, ${point.handedOff} handed off, ${point.crmActions} CRM outcomes`}>
            <span className="sr-only">{shortDate(point.day)}: {point.started} started, {point.completed} completed, {point.handedOff} handed off and {point.crmActions} CRM outcomes.</span>
            <span className="w-[42%] min-w-1 rounded-t bg-orange-400/80 motion-reduce:transition-none" style={{ height: `${Math.max(point.started ? 4 : 0, (point.started / max) * 100)}%` }} />
            <span className="w-[42%] min-w-1 rounded-t bg-emerald-400/80 motion-reduce:transition-none" style={{ height: `${Math.max(point.completed ? 4 : 0, (point.completed / max) * 100)}%` }} />
            {(index === 0 || index === points.length - 1 || (points.length <= 7 && index % 2 === 0)) && (
              <span className="absolute top-full mt-1 whitespace-nowrap text-[9px] text-muted-foreground">{shortDate(point.day)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
