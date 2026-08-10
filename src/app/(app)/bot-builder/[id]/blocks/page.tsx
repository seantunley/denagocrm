import Link from "next/link";
import { notFound } from "next/navigation";
import { Blocks, CopyPlus, Save, Trash2 } from "lucide-react";
import { requireOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getFlowSnippets } from "@/lib/flowSnippets";
import { builderOwnedWhere } from "@/lib/flowTenantScopeServer";
import { deleteFlowSnippet, insertSavedFlowSnippet, saveCurrentFlowAsSnippet } from "@/app/actions/flowSnippets";
import { WorkspaceHero } from "@/components/workspace-hero";
import { EmptyState, Surface } from "@/components/visual-system";

export default async function FlowBlocksPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  const [flow, snippets] = await Promise.all([
    // Saved blocks live in AppSetting, which settings.ts already resolves per
    // tenant; the draft this page saves FROM is what needed owning.
    prisma.botFlow.findFirst({ where: { id, ...builderOwnedWhere() } }),
    getFlowSnippets(),
  ]);
  if (!flow) notFound();

  return (
    <div className="space-y-5">
      <WorkspaceHero
        icon={Blocks}
        eyebrow="Reusable conversation design"
        title="Flow blocks"
        description="Save a compiler-clean flow as a reusable block, then copy it into another draft without creating a live runtime dependency between flows."
        stats={[
          { label: "Saved blocks", value: snippets.length, icon: Blocks },
          { label: "Current draft", value: flow.name, icon: Save },
        ]}
        actions={<Link href={`/bot-builder/${flow.id}`} className="btn-secondary btn-sm">← Back to draft</Link>}
      />

      <div className="grid gap-5 xl:grid-cols-[22rem_minmax(0,1fr)]">
        <Surface className="p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Save this draft as a block</p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">The saved block is a snapshot. Later edits to this flow will not change it, and later edits to the block will not change copies already inserted elsewhere.</p>
          <form action={saveCurrentFlowAsSnippet.bind(null, flow.id)} className="mt-4 space-y-3">
            <div><label className="label">Block name</label><input name="name" className="input" maxLength={180} required defaultValue={`${flow.name} block`} /></div>
            <div><label className="label">Description</label><textarea name="description" className="input" rows={3} maxLength={500} placeholder="What this block does and where to connect it" /></div>
            <button className="btn-primary btn-sm"><Save className="size-3.5" />Save reusable block</button>
          </form>
          <p className="mt-3 text-[10px] leading-4 text-muted-foreground">Only compiler-clean drafts can be saved as reusable blocks. Warnings are allowed; publish errors are not.</p>
        </Surface>

        <div className="space-y-4">
          {snippets.length === 0 ? (
            <EmptyState icon={Blocks} title="No reusable blocks yet" description="Save a clean draft on the left, then it can be copied into any other flow." />
          ) : snippets.map((snippet) => {
            const nodeCount = Object.keys(snippet.definition.nodes).length;
            return (
              <Surface key={snippet.id} className="p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0"><h2 className="font-semibold">{snippet.name}</h2>{snippet.description && <p className="mt-1 text-xs leading-5 text-muted-foreground">{snippet.description}</p>}<p className="mt-2 text-[10px] text-muted-foreground">{nodeCount} node{nodeCount === 1 ? "" : "s"} · saved {new Date(snippet.updatedAt).toLocaleDateString("en-ZA")}</p></div>
                  <form action={deleteFlowSnippet.bind(null, snippet.id)}><button className="btn-secondary btn-sm text-red-400" aria-label={`Delete ${snippet.name}`}><Trash2 className="size-3.5" /></button></form>
                </div>
                <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/25 p-3">
                  <p className="text-xs leading-5 text-muted-foreground">Insert a copied, disconnected block to the right of the current canvas. Open the draft afterwards and connect its entry node where you want it.</p>
                  <form action={insertSavedFlowSnippet.bind(null, flow.id, snippet.id)}><button className="btn-primary btn-sm shrink-0"><CopyPlus className="size-3.5" />Insert copy</button></form>
                </div>
              </Surface>
            );
          })}
        </div>
      </div>
    </div>
  );
}
