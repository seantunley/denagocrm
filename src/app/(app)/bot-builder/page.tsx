import Link from "next/link";
import { Copy, GitBranch, Layers3, Pencil, Plus, Radio, Trash2 } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { getSetting, putSetting } from "@/lib/settings";
import { DEFAULT_FLOW } from "@/lib/flow";
import { createFlow, setActiveFlow, duplicateFlow, deleteFlow, renameFlow } from "@/app/actions/flow";
import { WorkspaceHero } from "@/components/workspace-hero";
import { EmptyState, StatusPill, Surface } from "@/components/visual-system";

export default async function BotBuilderPage() {
  await requireOwner();

  // One-time seed / migrate the previous single flow into the library.
  if ((await prisma.botFlow.count()) === 0) {
    const legacy = await getSetting("BOT_FLOW");
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
    await prisma.botFlow.create({ data: { name, definition, active: true } });
    if (legacy) await putSetting("BOT_FLOW", "");
  }

  const flows = await prisma.botFlow.findMany({ orderBy: [{ active: "desc" }, { updatedAt: "desc" }] });

  return (
    <div className="space-y-5">
      <WorkspaceHero icon={GitBranch} eyebrow="Conversation design" title="Flow builder" description="Design guided customer journeys, test variations and choose the single flow that runs across every connected channel."
        stats={[
          { label: "Flows", value: flows.length, icon: Layers3 },
          { label: "Live", value: flows.filter((flow) => flow.active).length, icon: Radio, tone: "success" },
          { label: "Drafts", value: flows.filter((flow) => !flow.active).length, icon: Pencil },
          { label: "Channels", value: "One journey", icon: GitBranch },
        ]}
        actions={<form action={createFlow}>
          <input type="hidden" name="name" value="New flow" />
          <button className="btn-primary btn-sm"><Plus className="size-4" />New flow</button>
        </form>}
      />

      {flows.length === 0 ? <EmptyState icon={GitBranch} title="Create your first conversation" description="Start with a guided journey, then set it live when it is ready for customers." /> : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {flows.map((f) => (
          <Surface key={f.id} className="group flex min-h-52 flex-col p-5 transition hover:border-primary/35">
            <div className="flex items-center justify-between gap-2">
              <form action={renameFlow.bind(null, f.id)} className="flex-1 min-w-0">
                <input
                  name="name"
                  defaultValue={f.name}
                  className="bg-transparent font-semibold text-foreground w-full outline-none focus:bg-muted rounded px-1 -mx-1"
                />
              </form>
              {f.active ? (
                <StatusPill tone="success">Live</StatusPill>
              ) : (
                <form action={setActiveFlow.bind(null, f.id)}>
                  <button className="btn-secondary btn-sm">Set live</button>
                </form>
              )}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Updated {f.updatedAt.toLocaleDateString("en-ZA")}</p>
            <div className="my-5 flex flex-1 items-center gap-2 text-muted-foreground" aria-hidden>
              {[0, 1, 2].map((step) => <span key={step} className="flex items-center gap-2"><span className="grid size-8 place-items-center rounded-lg border border-border bg-muted/40"><GitBranch className="size-3.5" /></span>{step < 2 && <span className="h-px w-5 bg-border" />}</span>)}
            </div>
            <div className="flex gap-2 flex-wrap border-t border-border/70 pt-3">
              <Link href={`/bot-builder/${f.id}`} className="btn-primary btn-sm"><Pencil className="size-3.5" />Edit flow</Link>
              <form action={duplicateFlow.bind(null, f.id)}>
                <button className="btn-secondary btn-sm"><Copy className="size-3.5" />Duplicate</button>
              </form>
              {!f.active && (
                <form action={deleteFlow.bind(null, f.id)}>
                  <button className="btn-secondary btn-sm text-red-400" aria-label={`Delete ${f.name}`}><Trash2 className="size-3.5" /></button>
                </form>
              )}
            </div>
          </Surface>
        ))}
      </div>}
    </div>
  );
}
