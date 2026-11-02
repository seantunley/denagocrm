import { requireRoute } from "@/lib/permissions";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, ChevronDown, ExternalLink, GitBranch, Signpost, ToggleLeft } from "lucide-react";
import { builderTenantId, flowScope } from "@/lib/flowScope";
import { prisma } from "@/lib/db";
import { FLOW_CHANNELS } from "@/lib/flowRouting";
import { addFlowQr, addFlowRoute, deleteFlowQr, deleteFlowRoute, setFlowRouteEnabled } from "@/app/actions/flow";
import QRCode from "qrcode";
import { FLOW_QR_KEY, parseQrCodes, qrLink, qrSource } from "@/lib/flowQr";
import { businessWhatsApp } from "@/lib/flowContactCard";
import { getSetting } from "@/lib/settings";
import { getCompanyProfile } from "@/lib/companyProfile";
import { StatusPill, Surface } from "@/components/visual-system";
import { PageHeader } from "@/components/page-header";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";
import FlowRouteTester from "@/components/FlowRouteTester";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";

const channelLabel: Record<string, string> = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram", telegram: "Telegram" };
const kindLabel: Record<string, string> = { keyword: "Keyword phrase", referral: "Referral code", ad: "Ad ID" };

export default async function FlowRoutesPage() {
  await requireRoute("/bot-builder");
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

  // QR codes (lib/flowQr): each is a WhatsApp keyword route with a name; its image encodes wa.me + the typed message.
  // A QR code only replies when the chatbot and its guided flows are on (flowRun.isFlowEnabled) — said here, not
  // discovered by scanning one and getting nothing (Sean, 2026-11-02). And a QR's flow that is ALSO the live WhatsApp
  // flow answers every customer once the chatbot is on — said on its card.
  const [business, savedQrs, company, botOn, flowsOn, livePublication] = await Promise.all([
    businessWhatsApp(tenantId),
    getSetting(FLOW_QR_KEY),
    getCompanyProfile(),
    getSetting("BOT_ENABLED"),
    getSetting("BOT_FLOW_ENABLED"),
    prisma.botFlowPublication.findFirst({ where: { tenantId, channel: "whatsapp" }, select: { flowId: true } }),
  ]);
  const chatbotOff = botOn !== "true" || flowsOn !== "true";
  const businessName = company.name || "there";
  const whatsappFlows = flows.filter((flow) => flow.channel === "whatsapp" && publishedKeys.has(`whatsapp:${flow.id}`));
  const routeById = new Map(routes.map((route) => [route.id, route]));
  const qrs = business
    ? await Promise.all(
        parseQrCodes(savedQrs)
          .filter((qr) => routeById.has(qr.routeId))
          .map(async (qr) => {
            const route = routeById.get(qr.routeId)!;
            const link = qrLink(business.digits, qr.message);
            const [png, svg, people] = await Promise.all([
              QRCode.toDataURL(link, { margin: 1, width: 600 }),
              QRCode.toString(link, { type: "svg", margin: 1 }),
              prisma.contact.count({ where: { tenantId, source: qrSource(qr.name) } }),
            ]);
            return { ...qr, enabled: route.enabled, isLiveFlow: route.flowId === livePublication?.flowId, flowName: flowNames.get(route.flowId) ?? "Deleted flow", png, svg: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, people };
          }),
      )
    : [];

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
                  return <tr key={route.id} className={route.enabled ? "" : "opacity-55"}><td className="py-3 font-mono text-xs">{route.priority}</td><td className="py-3">{channelLabel[route.channel] ?? route.channel}</td><td className="py-3">{kindLabel[route.kind] ?? route.kind}</td><td className="py-3 font-mono text-xs">{route.pattern}</td><td className="py-3"><Link href={`/bot-builder/${route.flowId}`} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">{flowNames.get(route.flowId) ?? "Deleted flow"}<ExternalLink className="size-3" /></Link></td><td className="py-3">{latest ? <span className={`inline-flex items-center gap-1 text-xs ${drifted ? "text-amber-300" : "text-muted-foreground"}`}>{drifted && <AlertTriangle className="size-3.5" />}v{latest.version}{drifted ? " · route pinned older" : ""}</span> : <span className="text-xs text-red-300">Missing snapshot</span>}</td><td className="py-3"><div className="flex justify-end gap-2"><form action={setFlowRouteEnabled.bind(null, route.id, !route.enabled)}><button className="btn-secondary btn-sm">{route.enabled ? "Disable" : "Enable"}</button></form><ConfirmActionDialog trigger={<button type="button" className="btn-secondary btn-sm text-red-300">Delete</button>} title="Delete this route?" description="Messages it matched will go to the live flow (or the inbox) instead. If it belongs to a QR code, the QR code is deleted with it and printed copies stop starting its flow." confirmLabel="Delete route" destructive success="Route deleted" onConfirm={deleteFlowRoute.bind(null, route.id)} /></div></td></tr>;
                })}
              </tbody>
            </table>
          </ResponsiveEntityTable>
        )}
      </Surface>

      <Surface className="p-0" aria-labelledby="qr-heading">
        {/* Collapsible, as Channel routing below is (Sean, 2026-11-02: "it dominates this page"). Opens by itself when
            there is no QR code yet, or something needs attention. */}
        <details className="group" open={!business || qrs.length === 0 || chatbotOff || qrs.some((qr) => qr.isLiveFlow)}>
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 marker:content-none">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 id="qr-heading" className="font-semibold">QR codes (WhatsApp)</h2>
            <StatusPill tone={qrs.length ? "success" : "neutral"}>{qrs.length} {qrs.length === 1 ? "code" : "codes"}</StatusPill>
            {business && chatbotOff ? <StatusPill tone="warning">Chatbot off</StatusPill> : null}
          </div>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="border-t border-border/80 px-4 pb-4 pt-3">
        <p className="text-xs text-muted-foreground">Print one on a poster, flyer or stand. Scan → WhatsApp opens with your message typed → they tap Send → the flow replies. A new customer who arrives this way is saved with source “QR code — its name”.</p>
        {!business ? <p className="mt-3 text-sm text-amber-300">Connect your WhatsApp number (Settings → Integrations) before making a QR code.</p> : (
          <>
            {chatbotOff && (
              <p role="status" className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                The chatbot is switched off, so a scanned QR code reaches your inbox but nothing replies. Switch on the <strong>Assistant</strong> and <strong>Guided flow</strong> on the <Link href="/chatbot" className="underline">Chatbot page</Link>.
              </p>
            )}
            {qrs.length > 0 && (
              <div className="mt-3 divide-y divide-border/70 rounded-xl border border-border">
                {qrs.map((qr) => (
                  <div key={qr.routeId} className={`flex flex-wrap items-center gap-3 p-3 ${qr.enabled ? "" : "opacity-55"}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- a generated data URL, not a remote image */}
                    <img src={qr.png} alt={`QR code: ${qr.name}`} className="size-16 shrink-0 rounded bg-white p-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2"><h3 className="truncate font-medium">{qr.name}</h3><StatusPill tone={qr.enabled ? "success" : "neutral"}>{qr.enabled ? "On" : "Off"}</StatusPill></div>
                      <p className="truncate text-xs text-muted-foreground" title={qr.message}>“{qr.message}” → {qr.flowName}</p>
                      <p className="text-xs text-muted-foreground"><strong className="text-foreground">{qr.people}</strong> new {qr.people === 1 ? "customer" : "customers"} so far</p>
                      {qr.isLiveFlow && (
                        <p className="mt-0.5 text-xs text-amber-300">“{qr.flowName}” is also your live WhatsApp flow, so with the chatbot on it answers <strong>every</strong> customer message. Use <strong>Take offline</strong> on it in the Flow builder — this QR code keeps working.</p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <a className="btn-secondary btn-sm" href={qr.png} download={`QR ${qr.name}.png`}>Download PNG</a>
                      <a className="btn-secondary btn-sm" href={qr.svg} download={`QR ${qr.name}.svg`}>Download for print (SVG)</a>
                      <ConfirmActionDialog trigger={<button type="button" className="btn-secondary btn-sm text-red-300">Delete</button>} title={`Delete QR code “${qr.name}”?`} description="Printed copies stop starting its flow — a customer who scans one afterwards lands in the inbox instead. This can't be undone; a new QR code is a new image to print." confirmLabel="Delete QR code" destructive success="QR code deleted" onConfirm={deleteFlowQr.bind(null, qr.routeId)} />
                    </div>
                  </div>
                ))}
              </div>
            )}
            <details className="mt-3" open={qrs.length === 0}>
            <summary className="btn-secondary btn-sm inline-flex cursor-pointer list-none marker:content-none">+ New QR code</summary>
            <SaveForm action={addFlowQr} success="QR code saved" className="mt-3 grid gap-3 sm:grid-cols-3">
              <div><label className="label" htmlFor="qr-name">Name</label><input id="qr-name" name="name" className="input" required minLength={2} maxLength={60} placeholder="Showroom poster" /></div>
              <div><label className="label" htmlFor="qr-message">Message it types for them</label><input id="qr-message" name="message" className="input" required minLength={5} maxLength={200} defaultValue={`Hi ${businessName}, please send me the brochure`} /></div>
              <div><label className="label" htmlFor="qr-flow">Flow it starts</label><select id="qr-flow" name="flowId" className="input" required disabled={!whatsappFlows.length}><option value="">Choose a flow</option>{whatsappFlows.map((flow) => <option key={flow.id} value={flow.id}>{flow.name}</option>)}</select></div>
              <SaveButton className="btn-primary btn-sm sm:col-span-3" disabled={!whatsappFlows.length}>Make QR code</SaveButton>
            </SaveForm>
            {!whatsappFlows.length ? <p className="mt-2 text-[11px] text-amber-300">Publish a WhatsApp flow first — e.g. one that sends your brochure, price list and contact card.</p> : null}
            </details>
          </>
        )}
        </div>
        </details>
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
