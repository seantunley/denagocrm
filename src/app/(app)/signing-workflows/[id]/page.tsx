import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { parseGraph, blankWorkflow } from "@/lib/signflow/model";
import { deleteSignWorkflow } from "@/app/actions/signflow";
import ConfirmDelete from "@/components/ConfirmDelete";
import { listActingTenantStaff } from "@/lib/tenantActor";
import SignFlowBuilder from "@/components/signflow/SignFlowBuilder";

export const dynamic = "force-dynamic";

export default async function SignWorkflowEditor({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  const [wf, users] = await Promise.all([
    prisma.signWorkflow.findUnique({ where: { id } }),
    // Scope the approval-assignee picker to THIS tenant's active, non-disabled
    // members, so a workflow can't persist another tenant's (or a disabled) user id
    // onto an ApprovalStep.
    listActingTenantStaff(),
  ]);
  if (!wf || wf.deletedAt) notFound();
  const graph = parseGraph(wf.graphJson) ?? blankWorkflow();

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <Link href="/settings/signing-workflows" className="text-xs text-slate-400 hover:text-white">← All workflows</Link>
        <ConfirmDelete
          action={deleteSignWorkflow.bind(null, wf.id)}
          title={`Delete the signing workflow “${wf.name}”?`}
          description="The workflow is removed from your list and can't be chosen for new signing requests."
          trigger="Delete workflow"
          triggerClass="text-xs text-slate-500 hover:text-red-400 hover:underline"
        />
      </div>
      <SignFlowBuilder workflowId={wf.id} name={wf.name} initial={graph} staff={users} />
    </div>
  );
}
