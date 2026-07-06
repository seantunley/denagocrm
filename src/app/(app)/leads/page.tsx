import Link from "next/link";
import { prisma } from "@/lib/db";
import KanbanBoard, { type KanbanStage } from "@/components/KanbanBoard";
import ModalTrigger from "@/components/Modal";
import LeadForm from "@/components/LeadForm";
import { createLead } from "@/app/actions/leads";
import { contactName } from "@/lib/format";

export default async function LeadsPage() {
  const [stages, products, contacts, users] = await Promise.all([
    prisma.pipelineStage.findMany({
      orderBy: { order: "asc" },
      include: {
        leads: {
          where: { status: "open", deletedAt: null },
          orderBy: { position: "asc" },
          include: { product: true, assignedTo: true },
        },
      },
    }),
    prisma.product.findMany({
      where: { active: true },
      include: { colors: true },
      orderBy: { name: "asc" },
    }),
    prisma.contact.findMany({ orderBy: { firstName: "asc" }, take: 500 }),
    prisma.user.findMany({ orderBy: { name: "asc" } }),
  ]);

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
      assignee: l.assignedTo?.name ?? null,
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
          <ModalTrigger label="+ New lead" title="New lead">
            <LeadForm
              action={createLead}
              products={products.map((p) => ({
                id: p.id,
                name: p.name,
                basePriceCents: p.basePriceCents,
                colors: p.colors.map((c) => c.name),
              }))}
              stages={stages.map((s) => ({ id: s.id, name: s.name }))}
              contacts={contacts.map((c) => ({ id: c.id, label: contactName(c) }))}
              users={users.map((u) => ({ id: u.id, name: u.name }))}
              submitLabel="Create lead"
            />
          </ModalTrigger>
        </div>
      </div>
      <KanbanBoard stages={boardStages} />
    </div>
  );
}
