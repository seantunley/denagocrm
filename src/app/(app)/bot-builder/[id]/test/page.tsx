import { notFound } from "next/navigation";
import { FlaskConical } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import FlowSimulator from "@/components/FlowSimulator";
import { EntityDetailShell } from "@/components/entity-detail-shell";

export default async function FlowSimulatorPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  const flow = await prisma.botFlow.findUnique({ where: { id } });
  if (!flow) notFound();

  return (
    <EntityDetailShell
      backHref={`/bot-builder/${id}`}
      backLabel="Back to draft"
      eyebrow="Flow simulator"
      title={<span className="flex items-center gap-2"><FlaskConical className="size-5 text-primary" />Test {flow.name}</span>}
      status={flow.active ? <span className="badge bg-emerald-500/15 text-emerald-300">Live flow · testing draft</span> : undefined}
      description="Runs the saved draft through the production graph engine with every write and send replaced by a simulator effect."
    >
      <FlowSimulator flowId={flow.id} />
    </EntityDetailShell>
  );
}
