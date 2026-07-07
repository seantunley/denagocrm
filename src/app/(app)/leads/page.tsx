import Link from "next/link";
import { prisma } from "@/lib/db";
import { getDailyForecast } from "@/lib/weather";
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
          include: {
            product: true,
            assignedTo: true,
            activities: {
              where: { status: "planned", type: "test_drive", dueDate: { gte: new Date() } },
              orderBy: { dueDate: "asc" },
              take: 1,
            },
          },
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

  const forecast = await getDailyForecast();

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
      testDrive: (() => {
        const td = l.activities[0];
        if (!td) return null;
        const saDate = new Date(td.dueDate.getTime() + 2 * 60 * 60 * 1000);
        const dateKey = saDate.toISOString().slice(0, 10);
        const wx = forecast.get(dateKey);
        const hasTime = td.dueDate.getUTCHours() !== 0 || td.dueDate.getUTCMinutes() !== 0;
        return {
          when:
            saDate.toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short" }) +
            (hasTime ? ` ${saDate.toISOString().slice(11, 16)}` : ""),
          weather: wx ? `${wx.icon} ${wx.maxTemp}°${wx.rainChance >= 30 ? ` · ${wx.rainChance}% rain` : ""}` : null,
        };
      })(),
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
          <a href="/leads/list" className="btn-secondary">☰ List view</a>
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
