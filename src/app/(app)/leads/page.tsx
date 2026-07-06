import Link from "next/link";
import { prisma } from "@/lib/db";
import KanbanBoard, { type KanbanStage } from "@/components/KanbanBoard";

export default async function LeadsPage() {
  const stages = await prisma.pipelineStage.findMany({
    orderBy: { order: "asc" },
    include: {
      leads: {
        where: { status: "open" },
        orderBy: { position: "asc" },
        include: { product: true },
      },
    },
  });

  const boardStages: KanbanStage[] = stages.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
    leads: s.leads.map((l) => ({
      id: l.id,
      title: l.title,
      name: l.name,
      valueCents: l.valueCents,
      source: l.source,
      color: l.color,
      productName: l.product?.name ?? null,
    })),
  }));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold">Leads pipeline</h1>
        <div className="flex gap-2">
          <Link href="/leads/closed" className="btn-secondary">
            Won / Lost
          </Link>
          <Link href="/leads/new" className="btn-primary">
            + New lead
          </Link>
        </div>
      </div>
      <KanbanBoard stages={boardStages} />
    </div>
  );
}
