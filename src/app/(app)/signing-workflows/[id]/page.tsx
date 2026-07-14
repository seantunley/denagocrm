import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { parseGraph, blankWorkflow } from "@/lib/signflow/model";
import { deleteSignWorkflow } from "@/app/actions/signflow";
import SignFlowBuilder from "@/components/signflow/SignFlowBuilder";

export const dynamic = "force-dynamic";

export default async function SignWorkflowEditor({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  const [wf, users] = await Promise.all([
    prisma.signWorkflow.findUnique({ where: { id } }),
    prisma.user.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  if (!wf || wf.deletedAt) notFound();
  const graph = parseGraph(wf.graphJson) ?? blankWorkflow();

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <Link href="/settings/signing-workflows" className="text-xs text-slate-400 hover:text-white">← All workflows</Link>
        <form action={deleteSignWorkflow.bind(null, wf.id)}>
          <button className="text-xs text-slate-500 hover:text-red-400 hover:underline">Delete workflow</button>
        </form>
      </div>
      <SignFlowBuilder workflowId={wf.id} name={wf.name} initial={graph} staff={users} />
    </div>
  );
}
