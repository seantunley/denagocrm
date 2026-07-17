import Link from "next/link";
import { Prisma } from "@prisma/client";
import { Plus, List, Trophy } from "lucide-react";
import { prisma } from "@/lib/db";
import { getDailyForecast } from "@/lib/weather";
import KanbanBoard, { type KanbanStage } from "@/components/KanbanBoard";
import ModalTrigger from "@/components/Modal";
import LeadForm from "@/components/LeadForm";
import { PageHeader } from "@/components/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { createLead } from "@/app/actions/leads";
import { contactName, formatZAR } from "@/lib/format";

type PlannedActivityRow = {
  leadId: string;
  summary: string;
  dueDate: Date;
  type: string;
};

export default async function LeadsPage() {
  const now = new Date();
  const [stages, products, contacts, users] = await Promise.all([
    prisma.pipelineStage.findMany({
      orderBy: { order: "asc" },
      include: {
        leads: {
          where: { status: "open", deletedAt: null },
          orderBy: { createdAt: "desc" },
          include: {
            product: true,
            assignedTo: true,
            _count: { select: { activities: { where: { status: "planned" } } } },
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

  const leadIds = stages.flatMap((stage) => stage.leads.map((lead) => lead.id));
  let nextActivityRows: PlannedActivityRow[] = [];
  let nextTestDriveRows: PlannedActivityRow[] = [];

  if (leadIds.length) {
    [nextActivityRows, nextTestDriveRows] = await Promise.all([
      prisma.$queryRaw<PlannedActivityRow[]>(Prisma.sql`
        SELECT DISTINCT ON ("leadId")
          "leadId", "summary", "dueDate", "type"
        FROM "Activity"
        WHERE "leadId" IN (${Prisma.join(leadIds)})
          AND "status" = 'planned'
        ORDER BY "leadId", "dueDate" ASC
      `),
      prisma.$queryRaw<PlannedActivityRow[]>(Prisma.sql`
        SELECT DISTINCT ON ("leadId")
          "leadId", "summary", "dueDate", "type"
        FROM "Activity"
        WHERE "leadId" IN (${Prisma.join(leadIds)})
          AND "status" = 'planned'
          AND "type" = 'test_drive'
          AND "dueDate" >= ${now}
        ORDER BY "leadId", "dueDate" ASC
      `),
    ]);
  }

  const nextActivityByLead = new Map(nextActivityRows.map((activity) => [activity.leadId, activity]));
  const nextTestDriveByLead = new Map(nextTestDriveRows.map((activity) => [activity.leadId, activity]));
  const forecast = await getDailyForecast();

  // Active signing requests for these leads' quotes → a "quote sent · waiting for
  // X" badge on the card. Clears automatically once signing completes or is voided.
  const signingByLead = new Map<string, { label: string }>();
  if (leadIds.length) {
    const leadQuotes = await prisma.quote.findMany({
      where: { leadId: { in: leadIds }, deletedAt: null },
      select: { id: true, leadId: true },
    });
    const quoteToLead = new Map(leadQuotes.map((quote) => [quote.id, quote.leadId]));
    const quoteIds = leadQuotes.map((quote) => quote.id);
    if (quoteIds.length) {
      const requests = await prisma.signatureRequest.findMany({
        where: { quoteId: { in: quoteIds }, deletedAt: null, status: { in: ["sent", "viewed", "in_progress"] } },
        orderBy: { updatedAt: "desc" },
        include: { recipients: { orderBy: { order: "asc" } } },
      });
      for (const request of requests) {
        const leadId = request.quoteId ? quoteToLead.get(request.quoteId) : null;
        if (!leadId || signingByLead.has(leadId)) continue;
        const next = request.recipients.find(
          (recipient) => recipient.role !== "viewer" && recipient.status !== "signed" && recipient.status !== "declined",
        );
        signingByLead.set(leadId, {
          label: next ? `Quote sent · waiting for ${next.name.split(" ")[0]}` : "Quote fully signed",
        });
      }
    }
  }

  // The test-drive booking belongs to the test-drive stage; hide it on cards
  // parked before that stage.
  const testDriveStage = stages.find((stage) => /test/i.test(stage.name)) ?? null;

  const boardStages: KanbanStage[] = stages.map((stage) => ({
    id: stage.id,
    name: stage.name,
    color: stage.color,
    leads: stage.leads.map((lead) => {
      const nextActivity = nextActivityByLead.get(lead.id);
      const nextTestDrive = nextTestDriveByLead.get(lead.id);

      return {
        id: lead.id,
        title: lead.title,
        name: lead.name,
        valueCents: lead.valueCents,
        quantity: lead.quantity,
        source: lead.source,
        color: lead.color,
        productId: lead.productId,
        productName: lead.product?.name ?? null,
        assignee: lead.assignedTo?.name ?? null,
        research: lead.research,
        isNew: !lead.viewedAt && lead.createdAt.getTime() > now.getTime() - 3 * 24 * 60 * 60 * 1000,
        noNextStep: lead._count.activities === 0,
        ageDays: Math.floor((now.getTime() - lead.stageEnteredAt.getTime()) / 86400000),
        nextStep: nextActivity
          ? (() => {
              const saDate = new Date(nextActivity.dueDate.getTime() + 2 * 60 * 60 * 1000);
              const hasTime = nextActivity.dueDate.getUTCHours() !== 0 || nextActivity.dueDate.getUTCMinutes() !== 0;
              const label =
                saDate.toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short" }) +
                (hasTime ? ` at ${saDate.toISOString().slice(11, 16)}` : "");
              return {
                summary: nextActivity.summary,
                when: nextActivity.dueDate < now ? `Overdue · ${label}` : label,
                overdue: nextActivity.dueDate < now,
              };
            })()
          : null,
        testDrive:
          testDriveStage && stage.order < testDriveStage.order
            ? null
            : nextTestDrive
              ? (() => {
                  const saDate = new Date(nextTestDrive.dueDate.getTime() + 2 * 60 * 60 * 1000);
                  const dateKey = saDate.toISOString().slice(0, 10);
                  const weather = forecast.get(dateKey);
                  const hasTime =
                    nextTestDrive.dueDate.getUTCHours() !== 0 || nextTestDrive.dueDate.getUTCMinutes() !== 0;
                  return {
                    when:
                      saDate.toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short" }) +
                      (hasTime ? ` ${saDate.toISOString().slice(11, 16)}` : ""),
                    weather: weather
                      ? `${weather.icon} ${weather.maxTemp}°${weather.rainChance >= 30 ? ` · ${weather.rainChance}% rain` : ""}`
                      : null,
                    date: dateKey,
                  };
                })()
              : null,
        signing: signingByLead.get(lead.id) ?? null,
      };
    }),
  }));

  const openCount = boardStages.reduce((count, stage) => count + stage.leads.length, 0);
  const totalOpenValue = boardStages.reduce(
    (total, stage) => total + stage.leads.reduce((stageTotal, lead) => stageTotal + lead.valueCents, 0),
    0,
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Leads"
        description={`${openCount} open · ${formatZAR(totalOpenValue)} in pipeline`}
      >
        <Button asChild variant="ghost" size="sm">
          <Link href="/leads/closed">
            <Trophy className="size-4" />
            Won / Lost
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href="/leads/list">
            <List className="size-4" />
            List view
          </Link>
        </Button>
        <ModalTrigger
          label={
            <>
              <Plus className="size-4" />
              New lead
            </>
          }
          title="New lead"
          buttonClass={buttonVariants({ size: "sm" })}
        >
          <LeadForm
            action={createLead}
            products={products.map((product) => ({
              id: product.id,
              name: product.name,
              basePriceCents: product.basePriceCents,
              colors: product.colors.map((color) => color.name),
            }))}
            stages={stages.map((stage) => ({ id: stage.id, name: stage.name }))}
            contacts={contacts.map((contact) => ({ id: contact.id, label: contactName(contact) }))}
            users={users.map((user) => ({ id: user.id, name: user.name }))}
            submitLabel="Create lead"
            variant="dialog"
          />
        </ModalTrigger>
      </PageHeader>
      <KanbanBoard
        stages={boardStages}
        products={products.map((product) => ({ id: product.id, name: product.name }))}
      />
    </div>
  );
}
