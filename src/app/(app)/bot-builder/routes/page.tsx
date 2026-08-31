import Link from "next/link";
import { ArrowLeft, GitBranch, Route, Signpost, ToggleLeft } from "lucide-react";
import { requireOwner } from "@/lib/auth";
import { builderTenantId, flowScope } from "@/lib/flowScope";
import { prisma } from "@/lib/db";
import { FLOW_CHANNELS } from "@/lib/flowRouting";
import { addFlowRoute, deleteFlowRoute, setFlowRouteEnabled } from "@/app/actions/flow";
import { StatusPill, Surface } from "@/components/visual-system";
import { WorkspaceHero } from "@/components/workspace-hero";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";

const channelLabel: Record<string, string> = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram", telegram: "Telegram" };
const kindLabel: Record<string, string> = { keyword: "Keyword phrase", referral: "Referral code", ad: "Ad ID" };

export default async function FlowRoutesPage() {
  await requireOwner();
  const tenantId = await builderTenantId();
  const scope = await flowScope();
  const [routes, flows, publications, versions] = await Promise.all([
    prisma.botFlowRoute.findMany({ where: { tenantId }, orderBy: [{ channel: "asc" }, { priority: "asc" }, { createdAt: "asc" }] }),
    prisma.botFlow.findMany({ where: scope, select: { id: true, name: true, channel: true }, orderBy: { name: "asc" } }),
    prisma.botFlowPublication.findMany({ where: { tenantId }, select: { channel: true, flowId: true } }),
    prisma.botFlowVersion.findMany({ where: { tenantId }, select: { flowId: true, channel: true } }),
  ]);
  const publishedKeys = new Set(versions.map((version) => `${version.channel}:${version.flowId}`));
  const flowNames = new Map(flows.map((flow) => [flow.id, flow.name]));
  const defaults = new Map(publications.map((publication) => [publication.channel, publication.flowId]));

  return (
    <div className="space-y-5">
      <WorkspaceHero
        icon={Route}
        eyebrow="Conversation entry"
        title="Flow routing"
        description="Choose which published flow starts for each channel, keyword phrase, referral code or ad. Existing conversations stay pinned to the immutable version on which they began."
        stats={[
          { label: "Routes", value: routes.length, icon: Signpost },
          { label: "Enabled", value: routes.filter((route) => route.enabled).length, icon: ToggleLeft, tone: "success" },
          { label: "Published flows", value: new Set(versions.map((version) => version.flowId)).size, icon: GitBranch },
        ]}
        actions={<Link href="/bot-builder" className="btn-secondary btn-sm"><ArrowLeft className="size-4" />Flow library</Link>}
      />

      <Surface className="p-5">
        <h2 className="text-sm font-semibold">How selection works</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">On a new conversation or explicit restart, enabled routes are checked from the lowest priority number upward. The first match wins. If none match, the channel’s default published flow runs; channels with no default retain the existing WhatsApp fallback.</p>
      </Surface>

      <div className="grid gap-4 lg:grid-cols-2">
        {FLOW_CHANNELS.map((channel) => {
          const eligible = flows.filter((flow) => flow.channel === channel && publishedKeys.has(`${channel}:${flow.id}`));
          return (
            <Surface key={channel} className="p-5">
              <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">{channelLabel[channel]}</h2><p className="mt-1 text-xs text-muted-foreground">Default: {flowNames.get(defaults.get(channel) ?? "") ?? (channel === "whatsapp" ? "Built-in fallback" : "WhatsApp default")}</p></div><StatusPill tone={eligible.length ? "success" : "neutral"}>{eligible.length} published</StatusPill></div>
              <SaveForm action={addFlowRoute} success="Route saved" className="mt-4 grid gap-3 sm:grid-cols-2">
                <input type="hidden" name="channel" value={channel} />
                <div><label className="label" htmlFor={`${channel}-route-kind`}>Entry signal</label><select id={`${channel}-route-kind`} name="kind" className="input"><option value="keyword">Keyword phrase</option><option value="referral">Referral code</option><option value="ad">Ad ID</option></select></div>
                <div><label className="label" htmlFor={`${channel}-route-pattern`}>Value to match</label><input id={`${channel}-route-pattern`} name="pattern" className="input" required minLength={2} maxLength={180} placeholder="warranty" /></div>
                <div><label className="label" htmlFor={`${channel}-route-flow`}>Published flow</label><select id={`${channel}-route-flow`} name="flowId" className="input" required disabled={!eligible.length}><option value="">Choose a flow</option>{eligible.map((flow) => <option key={flow.id} value={flow.id}>{flow.name}</option>)}</select></div>
                <div><label className="label" htmlFor={`${channel}-route-priority`}>Priority</label><input id={`${channel}-route-priority`} name="priority" className="input" type="number" min={0} max={10000} defaultValue={100} /></div>
                <SaveButton className="btn-primary btn-sm sm:col-span-2" disabled={!eligible.length}>Add or replace route</SaveButton>
              </SaveForm>
              {!eligible.length ? <p className="mt-2 text-[11px] text-amber-300">Publish a {channelLabel[channel]} flow before adding routes.</p> : null}
            </Surface>
          );
        })}
      </div>

      <Surface className="p-5">
        <div className="flex items-center justify-between gap-3"><h2 className="font-semibold">Configured routes</h2><span className="text-xs text-muted-foreground">First enabled match wins</span></div>
        {routes.length === 0 ? <p className="mt-4 text-sm text-muted-foreground">No entry routes yet. Every channel currently uses its default publication.</p> : (
          <ResponsiveEntityTable className="mt-4">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="text-xs uppercase text-muted-foreground"><tr><th className="pb-2">Priority</th><th className="pb-2">Channel</th><th className="pb-2">Signal</th><th className="pb-2">Match</th><th className="pb-2">Published flow</th><th className="pb-2 text-right">Actions</th></tr></thead>
              <tbody className="divide-y divide-border">
                {routes.map((route) => <tr key={route.id} className={route.enabled ? "" : "opacity-55"}><td className="py-3 font-mono text-xs">{route.priority}</td><td className="py-3">{channelLabel[route.channel] ?? route.channel}</td><td className="py-3">{kindLabel[route.kind] ?? route.kind}</td><td className="py-3 font-mono text-xs">{route.pattern}</td><td className="py-3">{flowNames.get(route.flowId) ?? "Deleted flow"}</td><td className="py-3"><div className="flex justify-end gap-2"><form action={setFlowRouteEnabled.bind(null, route.id, !route.enabled)}><button className="btn-secondary btn-sm">{route.enabled ? "Disable" : "Enable"}</button></form><form action={deleteFlowRoute.bind(null, route.id)}><button className="btn-secondary btn-sm text-red-300">Delete</button></form></div></td></tr>)}
              </tbody>
            </table>
          </ResponsiveEntityTable>
        )}
      </Surface>
    </div>
  );
}
