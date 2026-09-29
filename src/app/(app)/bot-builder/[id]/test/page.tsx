import Link from "next/link";
import { notFound } from "next/navigation";
import { FlaskConical } from "lucide-react";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import FlowSimulator from "@/components/FlowSimulator";
import { EntityDetailShell } from "@/components/entity-detail-shell";
import { flowScope } from "@/lib/flowScope";
import { getCompanyProfile } from "@/lib/companyProfile";

export default async function FlowSimulatorPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  const scope = await flowScope();
  const flow = await prisma.botFlow.findFirst({ where: { id, ...scope } });
  if (!flow) notFound();

  /*
   * The name in the phone frame is THIS workspace's, from the same Company
   * Profile that names it on a quote. The simulator used to fall back to a
   * hardcoded "Denago Cape Town", so every other dealer previewed their chatbot
   * under someone else's business — in the one screen whose whole purpose is
   * showing the customer's exact view.
   */
  const company = await getCompanyProfile();

  return (
    <EntityDetailShell
      backHref={`/bot-builder/${id}`}
      backLabel="Back to draft"
      eyebrow="Flow simulator"
      title={<span className="flex items-center gap-2"><FlaskConical className="size-5 text-primary" />Test {flow.name}</span>}
      status={flow.active ? <span className="badge bg-emerald-500/15 text-emerald-300">Live flow · testing draft</span> : undefined}
      description="Runs the saved draft through the production graph engine with every write/send replaced by a simulator effect."
      actions={<Link href={`/bot-builder/${id}/evaluations`} className="btn-secondary btn-sm">Open evaluation suite</Link>}
    >
      <FlowSimulator flowId={flow.id} businessName={company.name} />
    </EntityDetailShell>
  );
}
