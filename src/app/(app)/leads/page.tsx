import Link from "next/link";
import { prisma, basePrisma } from "@/lib/db";
import { getDailyForecast } from "@/lib/weather";
import KanbanBoard, { type KanbanStage } from "@/components/KanbanBoard";
import ModalTrigger from "@/components/Modal";
import LeadForm from "@/components/LeadForm";
import { createLead } from "@/app/actions/leads";
import { contactName } from "@/lib/format";
import {
  getAccessibleLeadScope,
  hasPermission,
  requireAnyPermission,
  requirePermission,
} from "@/lib/permissions";
import { getDefaultPipeline, listActiveSalesPipelines, listPipelineStages } from "@/lib/pipelines";

export const dynamic = "force-dynamic";

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission("pipelines.view");
  await requireAnyPermission("leads.view_all", "leads.view_owned");
  const params = await searchParams;
  const [pipelines, defaultPipeline, forecast, scope, canCreate, canForecast] = await Promise.all([
    listActiveSalesPipelines(),
    getDefaultPipeline(),
    getDailyForecast(),
    getAccessibleLeadScope(user),
    hasPermission(user, "leads.create"),
    hasPermission(user, "forecast.view"),
  ]);

  const requested = typeof params.pipeline === "string" ? params.pipeline : null;
  const pipeline = pipelines.find((item) => item.id === requested) ?? defaultPipeline ?? pipelines[0];
  if (!pipeline) return <div className="card">No active sales pipeline is configured.</div>;
  const stages = await listPipelineStages(pipeline.id);

  const [products, contacts, users] = canCreate
    ? await Promise.all([
        prisma.product.findMany({ where: { active: true }, include: { colors: true }, orderBy: { name: "asc" } }),
        prisma.contact.findMany({ orderBy: { firstName: "asc" }, take: 500 }),
        prisma.user.findMany({ orderBy: { name: "asc" } }),
      ])
    : [[], [], []];

  const boardStages: KanbanStage[] = [];
  for (const stage of stages.filter((item) => !item.isClosed)) {
    const owned = await prisma.lead.findMany({
      where: {
        stageId: stage.id,
        status: "open",
        deletedAt: null,
        ...(scope.viewAll ? {} : { OR: [{ assignedToId: scope.userId }, { createdById: scope.userId }] }),
      },
      orderBy: { createdAt: "desc" },
      include: {
        product: true,
        assignedTo: true,
        activities: {
          where: { status: "planned", type: "test_drive", dueDate: { gte: new Date() } },
          orderBy: { dueDate: "asc" },
          take: 1,
        },
      },
    });

    let visible = owned;
    if (!scope.viewAll && scope.teamIds.length > 0) {
      const teamLeadIds = await basePrisma.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Lead"
        WHERE "stageId" = ${stage.id} AND "status" = 'open' AND "deletedAt" IS NULL
          AND "teamId" IN (
            SELECT "teamId" FROM "TeamMember" WHERE "userId" = ${scope.userId}
            UNION
            SELECT "id" FROM "Team" WHERE "managerId" = ${scope.userId} AND "deletedAt" IS NULL
          )
      `;
      const extraIds = new Set(teamLeadIds.map((row) => row.id));
      if (extraIds.size) {
        const extras = await prisma.lead.findMany({
          where: { id: { in: [...extraIds] } },
          include: {
            product: true,
            assignedTo: true,
            activities: {
              where: { status: "planned", type: "test_drive", dueDate: { gte: new Date() } },
              orderBy: { dueDate: "asc" },
              take: 1,
            },
          },
        });
        const merged = new Map([...owned, ...extras].map((lead) => [lead.id, lead]));
        visible = [...merged.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }
    }

    boardStages.push({
      id: stage.id,
      name: stage.name,
      color: stage.color,
      leads: visible.map((lead) => ({
        id: lead.id,
        title: lead.title,
        name: lead.name,
        valueCents: lead.valueCents,
        quantity: lead.quantity,
        source: lead.source,
        color: lead.color,
        productName: lead.product?.name ?? null,
        assignee: lead.assignedTo?.name ?? null,
        research: lead.research,
        isNew: !lead.viewedAt && lead.createdAt.getTime() > Date.now() - 3 * 24 * 60 * 60 * 1000,
        testDrive: (() => {
          const activity = lead.activities[0];
          if (!activity) return null;
          const date = new Date(activity.dueDate.getTime() + 2 * 60 * 60 * 1000);
          const dateKey = date.toISOString().slice(0, 10);
          const weather = forecast.get(dateKey);
          const hasTime = activity.dueDate.getUTCHours() !== 0 || activity.dueDate.getUTCMinutes() !== 0;
          return {
            when: date.toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short" })
              + (hasTime ? ` ${date.toISOString().slice(11, 16)}` : ""),
            weather: weather
              ? `${weather.icon} ${weather.maxTemp}°${weather.rainChance >= 30 ? ` · ${weather.rainChance}% rain` : ""}`
              : null,
            date: dateKey,
          };
        })(),
      })),
    });
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">{pipeline.name}</h1>
          <p className="text-sm text-slate-400">{pipeline.description ?? "Sales pipeline"}</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {canForecast && <Link href="/forecast" className="btn-secondary">Forecast</Link>}
          <Link href="/leads/closed" className="btn-secondary">Won / Lost</Link>
          <Link href="/leads/list" className="btn-secondary">☰ List view</Link>
          {canCreate && (
            <ModalTrigger label="+ New lead" title="New lead">
              <LeadForm
                action={createLead}
                products={products.map((product) => ({
                  id: product.id,
                  name: product.name,
                  basePriceCents: product.basePriceCents,
                  colors: product.colors.map((color) => color.name),
                }))}
                stages={stages.filter((stage) => !stage.isClosed).map((stage) => ({ id: stage.id, name: stage.name }))}
                contacts={contacts.map((contact) => ({ id: contact.id, label: contactName(contact) }))}
                users={users.map((item) => ({ id: item.id, name: item.name }))}
                submitLabel="Create lead"
              />
            </ModalTrigger>
          )}
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {pipelines.map((item) => (
          <Link
            key={item.id}
            href={`/leads?pipeline=${item.id}`}
            className={item.id === pipeline.id ? "btn-primary btn-sm" : "btn-secondary btn-sm"}
          >
            {item.name}
          </Link>
        ))}
      </div>
      <KanbanBoard stages={boardStages} />
    </div>
  );
}
