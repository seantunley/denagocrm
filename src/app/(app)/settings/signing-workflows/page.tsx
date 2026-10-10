import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireTenantOwner } from "@/lib/auth";
import { createSignWorkflow } from "@/app/actions/signflow";
import { parseGraph } from "@/lib/signflow/model";
import { formatDateTime } from "@/lib/format";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { setDefaultSignWorkflow } from "@/app/actions/signflowDefault";
import { defaultSignWorkflowId } from "@/lib/signflow/defaultWorkflow";
import { actingTenantId } from "@/lib/actingTenant";

export const dynamic = "force-dynamic";

/** Count signer steps in a saved graph (for the list summary). */
function signerCount(graph: unknown): number {
  const g = parseGraph(graph);
  if (!g) return 0;
  return Object.values(g.nodes).filter((n) => n.type === "signer").length;
}

export default async function SigningWorkflowsPage() {
  await requireTenantOwner();
  // This workspace's, named here rather than left to the scoped client: it adds
  // the workspace only while tenant enforcement is on, and with it off this list
  // was every workspace's workflows — which is also where their ids came from.
  const workflows = await prisma.signWorkflow.findMany({ where: { tenantId: await actingTenantId(), isArchived: false }, orderBy: { updatedAt: "desc" } });
  const defaultId = await defaultSignWorkflowId();
  const defaultWorkflow = workflows.find((w) => w.id === defaultId) ?? null;

  return (
    <SettingsWorkspace
      current="signing-workflows"
      title="Signing workflows"
      description="Design who signs, in what order, and the rules that route approvals."
      groups={SETTINGS_NAV_GROUPS}
    >

      <form action={createSignWorkflow} className="card flex flex-wrap items-end gap-2">
        <div className="flex-1">
          <label className="label">New workflow</label>
          <input name="name" className="input" placeholder="e.g. Manager approval over R500k" />
        </div>
        <button className="btn-primary">＋ Create</button>
      </form>

      {/* Which workflow a quote starts on. Until this existed one had to be
          picked by hand on every send, so a rule held only while everyone
          remembered to pick it. */}
      {workflows.length > 0 && (
        <p className="text-sm text-slate-400">
          {defaultWorkflow
            ? <>Every quote starts on <b className="text-foreground">{defaultWorkflow.name}</b>. Whoever sends it can still choose another, or the built-in flow.</>
            : <>No default: a quote is sent the built-in way — as its layout is drawn — unless a workflow is chosen when sending. Use <b className="text-foreground">Make default</b> to have every quote start on one.</>}
        </p>
      )}

      <div className="space-y-2">
        {workflows.length === 0 && <p className="text-sm text-slate-500">No workflows yet — create one above.</p>}
        {workflows.map((w) => (
          <div key={w.id} className="card flex flex-wrap items-center justify-between gap-3 hover:border-blue-500/40">
            <Link href={`/signing-workflows/${w.id}`} className="min-w-0 flex-1">
              <div className="font-medium">
                {w.name}
                {w.id === defaultWorkflow?.id && <span className="ml-2 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">Default for quotes</span>}
              </div>
              <div className="text-xs text-slate-400">{signerCount(w.graphJson)} signer step(s) · updated {formatDateTime(w.updatedAt)}</div>
            </Link>
            <SaveForm action={setDefaultSignWorkflow.bind(null, w.id === defaultWorkflow?.id ? "" : w.id)}>
              <SaveButton className="btn-secondary btn-sm" pendingLabel="Saving…">
                {w.id === defaultWorkflow?.id ? "Stop using as default" : "Make default"}
              </SaveButton>
            </SaveForm>
            <Link href={`/signing-workflows/${w.id}`} className="text-sm text-blue-400">Open →</Link>
          </div>
        ))}
      </div>
    </SettingsWorkspace>
  );
}
