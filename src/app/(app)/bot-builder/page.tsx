import Link from "next/link";
import { Copy, GitBranch, Layers3, Pencil, Plus, Radio, Route, Trash2 } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { getSetting, putSetting } from "@/lib/settings";
import { DEFAULT_FLOW, type Flow } from "@/lib/flow";
import { FLOW_TEMPLATES } from "@/lib/flowTemplates";
import { flowErrors, flowWarnings, validateFlow } from "@/lib/flowValidation";
import { enabledFlowChannels } from "@/lib/flowValidationServer";
import { getFlowPublicationMeta, publishFlowSnapshot } from "@/lib/flowPublishing";
import { createFlow, duplicateFlow, deleteFlow, renameFlow } from "@/app/actions/flow";
import PublishFlowButton from "@/components/PublishFlowButton";
import { WorkspaceHero } from "@/components/workspace-hero";
import { EmptyState, StatusPill, Surface } from "@/components/visual-system";
import { builderTenantId, flowScope } from "@/lib/flowScope";
import { DEFAULT_TENANT_ID } from "@/lib/tenant";
import { FLOW_CHANNELS } from "@/lib/flowRouting";

const channelLabel: Record<string, string> = { whatsapp: "WhatsApp", messenger: "Messenger", instagram: "Instagram", telegram: "Telegram" };

function parseDraft(definition: string): Flow | null {
  try {
    const parsed = JSON.parse(definition);
    return parsed?.start && parsed?.nodes ? parsed as Flow : null;
  } catch {
    return null;
  }
}

export default async function BotBuilderPage() {
  const owner = await requireOwner();
  const scope = await flowScope();

  const tenantId = await builderTenantId();
  if ((await prisma.botFlow.count({ where: scope })) === 0) {
    // The one-time import of the pre-BotFlow `BOT_FLOW` setting belongs to the
    // FOUNDING tenant and nobody else. getSetting/putSetting deliberately resolve
    // every key to the founding tenant while enforcement is dormant, so once the
    // list above became per-workspace this branch would have handed a brand new
    // workspace the founding tenant's conversation graph as its first flow — and
    // then CLEARED that tenant's setting on the way out. A cross-tenant read and a
    // destructive cross-tenant write, both introduced by scoping only the list.
    //
    // A second workspace starts from the shipped default, which is what it should
    // have started from.
    const founding = tenantId === DEFAULT_TENANT_ID;
    const legacy = founding ? await getSetting("BOT_FLOW") : null;
    let definition = JSON.stringify(DEFAULT_FLOW);
    let name = "Default flow";
    if (legacy) {
      try {
        const f = JSON.parse(legacy);
        if (f?.start && f?.nodes) {
          definition = legacy;
          name = "My flow";
        }
      } catch {
        /* keep default */
      }
    }
    const seeded = await prisma.botFlow.create({ data: { name, definition, active: true, tenantId } });
    await publishFlowSnapshot(seeded.id, owner.id).catch(() => {});
    if (legacy) await putSetting("BOT_FLOW", "");
  }

  const [flows, publicationMeta, channels] = await Promise.all([
    prisma.botFlow.findMany({ where: scope, orderBy: [{ active: "desc" }, { updatedAt: "desc" }] }),
    getFlowPublicationMeta(),
    enabledFlowChannels(),
  ]);
  const validation = new Map(flows.map((flow) => {
    const parsed = parseDraft(flow.definition);
    const issues = parsed
      ? validateFlow(parsed, channels)
      : [{ severity: "error" as const, code: "graph.shape", message: "Flow definition is malformed." }];
    return [flow.id, { issues, errors: flowErrors(issues), warnings: flowWarnings(issues) }];
  }));

  const hasDraftChanges = (flow: (typeof flows)[number]) => {
    const publication = publicationMeta.get(flow.id);
    return flow.active && (!publication || flow.updatedAt > publication.publishedAt);
  };
  const pendingDrafts = flows.filter((flow) => !flow.active || hasDraftChanges(flow)).length;

  return (
    <div className="space-y-5">
      <WorkspaceHero
        icon={GitBranch}
        eyebrow="Conversation design"
        title="Flow builder"
        description="Design guided customer journeys as drafts, validate them against every enabled channel, then publish an immutable version when they are ready for customers."
        stats={[
          { label: "Flows", value: flows.length, icon: Layers3 },
          { label: "Live", value: flows.filter((flow) => flow.active).length, icon: Radio, tone: "success" },
          { label: "Drafts / changes", value: pendingDrafts, icon: Pencil },
          { label: "Channels checked", value: channels.length, icon: GitBranch },
        ]}
        actions={<div className="flex flex-wrap gap-2"><Link href="/bot-builder/routes" className="btn-secondary btn-sm"><Route className="size-4" />Routing</Link><form action={createFlow} className="flex gap-2"><input type="hidden" name="templateId" value="general" /><input type="hidden" name="name" value="New flow" /><select name="channel" className="input h-9 w-32 text-xs" aria-label="New flow channel">{FLOW_CHANNELS.map((channel) => <option key={channel} value={channel}>{channelLabel[channel]}</option>)}</select><button className="btn-primary btn-sm"><Plus className="size-4" />Blank-ish flow</button></form></div>}
      />

      <Surface className="p-5">
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Start from a template</p>
            <h2 className="mt-1 text-lg font-semibold">Create a useful first draft, not an empty canvas</h2>
            <p className="mt-1 text-xs text-muted-foreground">Templates are normal drafts after creation. Edit anything, run the simulator, then publish when the compiler is clean.</p>
          </div>
          <span className="text-xs text-muted-foreground">{FLOW_TEMPLATES.length} starters</span>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {FLOW_TEMPLATES.map((template) => (
            <form key={template.id} action={createFlow} className="flex min-h-40 flex-col rounded-xl border border-border bg-muted/25 p-4 hover:border-primary/35">
              <input type="hidden" name="templateId" value={template.id} />
              <input type="hidden" name="name" value={template.name} />
              <div className="flex items-center gap-2"><span className="grid size-8 place-items-center rounded-lg border border-border bg-card"><GitBranch className="size-4" /></span><p className="font-medium">{template.name}</p></div>
              <p className="mt-3 flex-1 text-xs leading-5 text-muted-foreground">{template.description}</p>
              <label className="label mt-3" htmlFor={`template-channel-${template.id}`}>Channel</label>
              <select id={`template-channel-${template.id}`} name="channel" className="input h-9 text-xs">{FLOW_CHANNELS.map((channel) => <option key={channel} value={channel}>{channelLabel[channel]}</option>)}</select>
              <button className="btn-secondary btn-sm mt-4 w-full"><Plus className="size-3.5" />Use template</button>
            </form>
          ))}
        </div>
      </Surface>

      {flows.length === 0 ? <EmptyState icon={GitBranch} title="Create your first conversation" description="Choose a starter above, then publish it when it is ready for customers." /> : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {flows.map((f) => {
          const publication = publicationMeta.get(f.id);
          const pending = hasDraftChanges(f);
          const check = validation.get(f.id)!;
          const blocked = check.errors.length > 0;
          return (
            <Surface key={f.id} className="group flex min-h-52 flex-col p-5 transition hover:border-primary/35">
              <div className="flex items-center justify-between gap-2">
                <form action={renameFlow.bind(null, f.id)} className="flex-1 min-w-0"><input name="name" defaultValue={f.name} className="bg-transparent font-semibold text-foreground w-full outline-none focus:bg-muted rounded px-1 -mx-1" /></form>
                <div className="flex items-center gap-1.5 flex-wrap justify-end">
                  {f.active && <StatusPill tone="success">Live</StatusPill>}
                  <StatusPill tone="neutral">{channelLabel[f.channel] ?? f.channel}</StatusPill>
                  {pending && <StatusPill tone="warning">Draft changed</StatusPill>}
                  {blocked && <StatusPill tone="danger">{check.errors.length} error{check.errors.length === 1 ? "" : "s"}</StatusPill>}
                </div>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">Draft updated {f.updatedAt.toLocaleDateString("en-ZA")}{publication ? ` · published ${publication.publishedAt.toLocaleDateString("en-ZA")}` : " · not versioned yet"}</p>
              {(blocked || check.warnings.length > 0) && <p className={`mt-2 text-xs ${blocked ? "text-red-300" : "text-amber-300"}`}>{blocked ? check.errors[0].message : `${check.warnings.length} warning${check.warnings.length === 1 ? "" : "s"} — review before publishing.`}</p>}
              <div className="my-5 flex flex-1 items-center gap-2 text-muted-foreground" aria-hidden>{[0,1,2].map((step) => <span key={step} className="flex items-center gap-2"><span className="grid size-8 place-items-center rounded-lg border border-border bg-muted/40"><GitBranch className="size-3.5" /></span>{step < 2 && <span className="h-px w-5 bg-border" />}</span>)}</div>
              <div className="flex gap-2 flex-wrap border-t border-border/70 pt-3">
                <Link href={`/bot-builder/${f.id}`} className="btn-primary btn-sm"><Pencil className="size-3.5" />Edit draft</Link>
                {(!f.active || pending) && !blocked && <PublishFlowButton flowId={f.id} label={f.active ? "Publish changes" : "Publish"} />}
                {(!f.active || pending) && blocked && <span className="btn-secondary btn-sm cursor-not-allowed opacity-50" title="Fix publish errors first">Publish blocked</span>}
                <form action={duplicateFlow.bind(null, f.id)}><button className="btn-secondary btn-sm"><Copy className="size-3.5" />Duplicate</button></form>
                {!f.active && <form action={deleteFlow.bind(null, f.id)}><button className="btn-secondary btn-sm text-red-400" aria-label={`Delete ${f.name}`}><Trash2 className="size-3.5" /></button></form>}
              </div>
            </Surface>
          );
        })}
      </div>}
    </div>
  );
}
