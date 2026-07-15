import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { createSignWorkflow } from "@/app/actions/signflow";
import { parseGraph } from "@/lib/signflow/model";
import { formatDateTime } from "@/lib/format";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";

export const dynamic = "force-dynamic";

/** Count signer steps in a saved graph (for the list summary). */
function signerCount(graph: unknown): number {
  const g = parseGraph(graph);
  if (!g) return 0;
  return Object.values(g.nodes).filter((n) => n.type === "signer").length;
}

export default async function SigningWorkflowsPage() {
  await requireOwner();
  const workflows = await prisma.signWorkflow.findMany({ where: { isArchived: false }, orderBy: { updatedAt: "desc" } });

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

      <div className="space-y-2">
        {workflows.length === 0 && <p className="text-sm text-slate-500">No workflows yet — create one above.</p>}
        {workflows.map((w) => (
          <Link key={w.id} href={`/signing-workflows/${w.id}`} className="card flex items-center justify-between hover:border-blue-500/40">
            <div>
              <div className="font-medium">{w.name}</div>
              <div className="text-xs text-slate-400">{signerCount(w.graphJson)} signer step(s) · updated {formatDateTime(w.updatedAt)}</div>
            </div>
            <span className="text-sm text-blue-400">Open →</span>
          </Link>
        ))}
      </div>
    </SettingsWorkspace>
  );
}
