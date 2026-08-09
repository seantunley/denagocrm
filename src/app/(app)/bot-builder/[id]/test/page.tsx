import Link from "next/link";
import { notFound } from "next/navigation";
import { FlaskConical } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import FlowSimulator from "@/components/FlowSimulator";

export default async function FlowSimulatorPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  const flow = await prisma.botFlow.findUnique({ where: { id } });
  if (!flow) notFound();

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <Link href={`/bot-builder/${id}`} className="text-sm text-orange-400 hover:underline">← Back to draft</Link>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-[-0.035em]"><FlaskConical className="size-5 text-primary" />Test {flow.name}</h1>
          <p className="mt-1 text-sm text-slate-400">Runs the saved draft through the production graph engine with every write/send replaced by a simulator effect.</p>
        </div>
        {flow.active && <span className="badge bg-emerald-500/15 text-emerald-300">Live flow · testing draft</span>}
      </div>
      <FlowSimulator flowId={flow.id} />
    </div>
  );
}
