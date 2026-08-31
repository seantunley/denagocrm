import Link from "next/link";
import { AlertTriangle, ArrowLeft, ChevronDown, ExternalLink, GitBranch, Signpost, ToggleLeft } from "lucide-react";
import { requireOwner } from "@/lib/auth";
import { builderTenantId, flowScope } from "@/lib/flowScope";
import { prisma } from "@/lib/db";
import { FLOW_CHANNELS } from "@/lib/flowRouting";
import { addFlowRoute, deleteFlowRoute, setFlowRouteEnabled } from "@/app/actions/flow";
import { StatusPill, Surface } from "@/components/visual-system";
import { PageHeader } from "@/components/page-header";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";
import FlowRouteTester from "@/components/FlowRouteTester";

const channelLabel: Record<string, string> = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram", telegram: "Telegram" };
const kindLabel: Record<string, string> = { keyword: "Keyword phrase", referral: "Referral code", ad: "Ad ID" };

export default async function FlowRoutesPage() {
  await requireOwner();
  const tenantId = await builderTenantId();
  const scope = await flowScope();
  const [routes, flows, publications, versions] = await Promise.all([
    prisma.botFlowRoute.findMany({ where: { tenantId }, orderBy: [{ channel: "asc" }, { priority: "asc" }, { createdAt: "asc" }] }),
    prisma.botFlow.findMany({ where: scope, select: { id: true, name: true, channel: true }, orderBy: { name: "asc" } }),
    prisma.botFlowPublication.findMany({ where: { tenantId }, select: { channel: true, flowId: true, versionId: true } }),
    prisma.botFlowVersion.findMany({ where: { tenantId }, select: { id: true, flowId: true, channel: true, version: true }, orderBy: { version: "desc" } }),
  ]);
  const publishedKeys = new Set(versions.map((version) => `${version.channel}:${version.flowId}`));
  const flowNames = new Map(flows.map((flow) => [flow.id, flow.name]));
  const defaults = new Map(publications.map((publication) => [publication.channel, publication.flowId]));
  const latestVersionByFlow = new Map<string, (typeof versions)[number]>();
  for (const version of versions) if (!latestVersionByFlow.has(version.flowId)) latestVersionByFlow.set(version.flowId, version);

  const testRoutes = routes.map((route) => ({
    id: route.id,
    channel: route.channel,
    kind: route.kind,
    pattern: route.pattern,
    priority: route.priority,
    enabled: route.enabled,
    flowName: flowNames.get(route.flowId) ?? "Deleted flow",
  }));

  const enabledCount = routes.filter((route) => route.enabled).length;
  const publishedFlowCount = new Set(versions.map((version) => version.flowId)).size;

  return (
    <div className="space-y-3">
      <PageHeader
        title="Flow routing"
        description="Choose which published flow starts for each channel, keyword phrase, referral code or ad. Existing conversations stay pinned to the immutable version on which they began."
        className="border-b border-border/80 pb-3"
      >
        <Link href="/bot-builder" className="btn-secondary btn-sm min-h-11 sm:min-h-9"><ArrowLeft className="size-4" />Flow library</Link>
      </PageHeader>

      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground" aria-label="Routing summary">
        <span className="inline-flex items-center gap-1.5"><Signpost className="size-3.5" aria-hidden="true" /><strong className="text-foreground">{routes.length}</strong> routes</span>
        <span className="inline-flex items-center gap-1.5"><ToggleLeft className="size-3.5" aria-hidden="true" /><strong className="text-foreground">{enabledCount}</strong> enabled</span>
        <span className="inline-flex items-center gap-1.5"><GitBranch className="size-3.5" aria-hidden="true" /><strong className="text-foreground">{publishedFlowCount}</strong> published flows</span>
      </div>

      <details className="group rounded-lg border border-border/80 bg-card/40 px-3 py-2 text-xs">
        <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-3 font-medium marker:content-none">
          <span>How routing works & test a match</span>
          <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="space-y-3 pb-1 pt-2">
          <p className="leading-5 text-muted-foreground">On a new conversation or explicit restart, enabled routes are checked from the lowest priority number upward. The first match wins. If none match, the channel’s default published flow runs; channels with no default retain the existing WhatsApp fallback.</p>
          <FlowRouteTester routes={testRoutes} />
        </div>
      </details>

      <Surface className="p-4">
        <div className="flex items-center justify-between gap-3"><h2 className="font-semibold">Configured routes</h2><span className="text-xs text-muted-foreground">First enabled match wins</span></div>
        {routes.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">No entry routes yet. Every channel currently uses its default publication.</p> : (
          <ResponsiveEntityTable className="mt-3">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="text-xs uppercase text-muted-foreground"><tr><th className="pb-2">Priority</th><th className="pb-2">Channel</th><th className="pb-2">Signal</th><th className="pb-2">Match</th><th className="pb-2">Published flow</th><th className="pb-2">Version</th><th className="pb-2 text-right">Actions</th></tr></thead>
              <tbody className="divide-y divide-border">
                {routes.map((route) => {
                  const latest = latestVersionByFlow.get(route.flowId);
                  const drifted = Boolean(latest && latest.id !== route.publishedVersionId);
                  return <tr key={route.id} className={route.enabled ? "" : "opacity-55"}><td className="py-3 font-mono text-xs">{route.priority}</td><td className="py-3">{channelLabel[route.channel] ?? route.channel}</td><td className="py-3">{kindLabel[route.kind] ?? route.kind}</td><td className="py-3 font-mono text-xs">{route.pattern}</td><td className="py-3"><Link href={`/bot-builder/${route.flowId}`} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">{flowNames.get(route.flowId) ?? "Deleted flow"}<ExternalLink className="size-3" /></Link></td><td className="py-3">{latest ? <span className={`inline-flex items-center gap-1 text-xs ${drifted ? "text-amber-300" : "text-muted-foreground"}`}>{drifted && <AlertTriangle className="size-3.5" />}v{latest.version}{drifted ? " · route pinned older" : ""}</span> : <span className="text-xs text-red-300">Missing snapshot</span>}</td><td className="py-3"><div className="flex justify-end gap-2"><form action={setFlowRouteEnabled.bind(null, route.id, !route.enabled)}><button className="btn-secondary btn-sm">{route.enabled ? "Disable" : "Enable"}</button></form><form action={deleteFlowRoute.bind(null, route.id)}><button className="btn-secondary btn-sm text-red-300">Delete</button></form></div></td></tr>;
                })}
              </tbody>
            </table>
          </ResponsiveEntityTable>
        )}
      </Surface>

      <section aria-labelledby="channel-routing-heading">
        <div className="mb-2 flex items-center justify-between gap-3"><h2 id="channel-routing-heading" className="text-sm font-semibold">Channel routing</h2><span className="text-xs text-muted-foreground">Expand a channel to add a route</span></div>
        <div className="grid gap-2 lg:grid-cols-2">
          {FLOW_CHANNELS.map((channel) => {
            const eligible = flows.filter((flow) => flow.channel === channel && publishedKeys.has(`${channel}:${flow.id}`));
            const defaultName = flowNames.get(defaults.get(channel) ?? "") ?? (channel === "whatsapp" ? "Built-in fallback" : "WhatsApp default");
            return (
              <details key={channel} className="group rounded-xl border border-border bg-card/50">
                <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2 marker:content-none">
                  <div className="min-w-0"><div className="flex items-center gap-2"><h3 className="font-semibold">{channelLabel[channel]}</h3><StatusPill tone={eligible.length ? "success" : "neutral"}>{eligible.length} published</StatusPill></div><p className="mt-0.5 truncate text-xs text-muted-foreground">Default: {defaultName}</p></div>
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
                </summary>
                <div className="border-t border-border/80 px-4 py-3">
                  <SaveForm action={addFlowRoute} success="Route saved" className="grid gap-3 sm:grid-cols-2">
                    <input type="hidden" name="channel" value={channel} />
                    <div><label className="label" htmlFor={`${channel}-route-kind`}>Entry signal</label><select id={`${channel}-route-kind`} name="kind" className="input"><option value="keyword">Keyword phrase</option><option value="referral">Referral code</option><option value="ad">Ad ID</option></select></div>
                    <div><label className="label" htmlFor={`${channel}-route-pattern`}>Value to match</label><input id={`${channel}-route-pattern`} name="pattern" className="input" required minLength={2} maxLength={180} placeholder="warranty" /></div>
                    <div><label className="label" htmlFor={`${channel}-route-flow`}>Published flow</label><select id={`${channel}-route-flow`} name="flowId" className="input" required disabled={!eligible.length}><option value="">Choose a flow</option>{eligible.map((flow) => <option key={flow.id} value={flow.id}>{flow.name}</option>)}</select></div>
                    <div><label className="label" htmlFor={`${channel}-route-priority`}>Priority</label><input id={`${channel}-route-priority`} name="priority" className="input" type="number" min={0} max={10000} defaultValue={100} /></div>
                    <SaveButton className="btn-primary btn-sm sm:col-span-2" disabled={!eligible.length}>Add or replace route</SaveButton>
                  </SaveForm>
                  {!eligible.length ? <p className="mt-2 text-[11px] text-amber-300">Publish a {channelLabel[channel]} flow before adding routes.</p> : null}
                </div>
              </details>
            );
          })}
        </div>
      </section>
    </div>
  );
}
