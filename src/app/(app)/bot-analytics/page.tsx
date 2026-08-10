import Link from "next/link";
import { BarChart3, GitBranch, MessagesSquare, Radio, UserRound } from "lucide-react";
import { requireOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getBotFlowAnalyticsReport } from "@/lib/botFlowAnalyticsReport";
import { WorkspaceHero } from "@/components/workspace-hero";
import { EmptyState, StatusPill, Surface } from "@/components/visual-system";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";
import { flowScope } from "@/lib/flowScope";

const pct = (part: number, total: number) => total > 0 ? `${Math.round((part / total) * 1000) / 10}%` : "—";
const channelLabel = (channel: string) => channel === "whatsapp" ? "WhatsApp" : channel === "instagram" ? "Instagram" : channel === "messenger" ? "Messenger" : channel === "telegram" ? "Telegram" : channel;

export default async function BotAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ flowId?: string }>;
}) {
  await requireOwner();
  const params = await searchParams;
  const scope = await flowScope();
  const flows = await prisma.botFlow.findMany({
    where: scope,
    select: { id: true, name: true, active: true, updatedAt: true },
    orderBy: [{ active: "desc" }, { updatedAt: "desc" }],
  });
  const selected = flows.find((flow) => flow.id === params.flowId) ?? flows[0] ?? null;
  const report = selected ? await getBotFlowAnalyticsReport(selected.id) : null;

  return (
    <div className="space-y-5">
      <WorkspaceHero
        icon={BarChart3}
        eyebrow="Conversation performance"
        title="Chatbot analytics"
        description="See how published conversation flows perform by immutable version, channel and node, including automatic one-shot runs, CRM actions, handoffs and terminal delivery failures."
        stats={report ? [
          { label: "Flow runs", value: report.allTime.started, icon: MessagesSquare },
          { label: "Completed", value: pct(report.allTime.completed, report.allTime.started), icon: Radio, tone: "success" },
          { label: "Handed off", value: pct(report.allTime.handedOff, report.allTime.started), icon: UserRound },
          { label: "Published versions", value: report.versions.length, icon: GitBranch },
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
                href={`/bot-analytics?flowId=${encodeURIComponent(flow.id)}`}
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
          <div className="grid gap-4 lg:grid-cols-2">
            <Surface className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Latest published version</p>
                  <h2 className="mt-1 text-lg font-semibold">{selected.name}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {report.latestVersion ? `Version ${report.latestVersion.version} · published ${report.latestVersion.publishedAt.toLocaleDateString("en-ZA")}` : "No immutable published version yet"}
                  </p>
                </div>
                {selected.active && <StatusPill tone="success">Live</StatusPill>}
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <Metric label="Flow runs" value={String(report.latest.started)} />
                <Metric label="Completed" value={`${report.latest.completed} · ${pct(report.latest.completed, report.latest.started)}`} />
                <Metric label="Handed off" value={`${report.latest.handedOff} · ${pct(report.latest.handedOff, report.latest.started)}`} />
                <Metric label="Delivery failures" value={String(report.latest.deliveryFailures)} />
              </div>
              <div className="mt-4"><Link href={`/bot-builder/${selected.id}`} className="text-xs text-orange-400 hover:underline">Open this flow draft →</Link></div>
            </Surface>

            <Surface className="p-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">All published versions · by channel</p>
              <div className="mt-3 space-y-2">
                {report.channels.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No published flow runs have been recorded yet.</p>
                ) : report.channels.map((channel) => (
                  <div key={channel.channel} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 rounded-xl border border-border bg-muted/30 px-3 py-2.5">
                    <div><p className="text-sm font-medium">{channelLabel(channel.channel)}</p><p className="text-[10px] text-muted-foreground">{channel.conversations} run{channel.conversations === 1 ? "" : "s"}</p></div>
                    <div className="text-right"><p className="text-xs font-medium text-emerald-300">{pct(channel.completed, channel.conversations)}</p><p className="text-[10px] text-muted-foreground">complete</p></div>
                    <div className="text-right"><p className="text-xs font-medium text-amber-300">{pct(channel.handedOff, channel.conversations)}</p><p className="text-[10px] text-muted-foreground">handoff</p></div>
                  </div>
                ))}
              </div>
            </Surface>
          </div>

          <Surface className="overflow-hidden">
            <div className="border-b border-border px-5 py-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Latest-version funnel</p>
              <p className="mt-1 text-sm text-muted-foreground">Reach is a recorded visit to a waiting node. Progress and drop-off apply to menus, captures and slot selection; successful CRM and Journey effects are counted separately.</p>
            </div>
            {report.nodes.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">No node-level activity has been recorded for this version yet.</div>
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
            Run totals include both stateful guided conversations and automatic one-shot graphs. A deliberate restart creates a new flow run. Delivery failures appear only after an outbox message becomes terminally dead.
          </p>
        </>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-border bg-muted/30 p-3"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-1 text-lg font-semibold">{value}</p></div>;
}
