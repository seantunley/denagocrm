import Link from "next/link";
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
  const [nextActivities, futureTestDrives, forecast] = await Promise.all([
    leadIds.length
      ? prisma.activity.findMany({
          where: { leadId: { in: leadIds }, status: "planned" },
          orderBy: [{ leadId: "asc" }, { dueDate: "asc" }],
          distinct: ["leadId"],
          select: { leadId: true, summary: true, dueDate: true },
        })
      : [],
    leadIds.length
      ? prisma.activity.findMany({
          where: {
            leadId: { in: leadIds },
            status: "planned",
            type: "test_drive",
            dueDate: { gte: now },
          },
          orderBy: [{ leadId: "asc" }, { dueDate: "asc" }],
          distinct: ["leadId"],
          select: { leadId: true, dueDate: true },
        })
      : [],
    getDailyForecast(),
  ]);

  const nextActivityByLead = new Map(nextActivities.map((activity) => [activity.leadId, activity]));
  const testDriveByLead = new Map(futureTestDrives.map((activity) => [activity.leadId, activity]));

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
        where: {
          quoteId: { in: quoteIds },
          deletedAt: null,
          status: { in: ["sent", "viewed", "in_progress"] },
        },
        orderBy: { updatedAt: "desc" },
        include: { recipients: { orderBy: { order: "asc" } } },
      });
      for (const request of requests) {
        const leadId = request.quoteId ? quoteToLead.get(request.quoteId) : null;
        if (!leadId || signingByLead.has(leadId)) continue;
        const nextRecipient = request.recipients.find(
          (recipient) => recipient.role !== "viewer" && recipient.status !== "signed" && recipient.status !== "declined",
        );
        signingByLead.set(leadId, {
          label: nextRecipient ? `Quote sent · waiting for ${nextRecipient.name.split(" ")[0]}` : "Quote fully signed",
        });
      }
    }
  }

  const testDriveStage = stages.find((stage) => /test/i.test(stage.name)) ?? null;

  const boardStages: KanbanStage[] = stages.map((stage) => ({
    id: stage.id,
    name: stage.name,
    color: stage.color,
    leads: stage.leads.map((lead) => {
      const nextActivity = nextActivityByLead.get(lead.id) ?? null;
      const signing = signingByLead.get(lead.id) ?? null;
      const overdue = Boolean(nextActivity && nextActivity.dueDate < now);
      const nextStep = (() => {
        if (!nextActivity && !signing) return null;
        if (!nextActivity) {
          return { summary: signing!.label, when: "Signing in progress", overdue: false };
        }
        const saDate = new Date(nextActivity.dueDate.getTime() + 2 * 60 * 60 * 1000);
        const hasTime = nextActivity.dueDate.getUTCHours() !== 0 || nextActivity.dueDate.getUTCMinutes() !== 0;
        const label =
          saDate.toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short" }) +
          (hasTime ? ` at ${saDate.toISOString().slice(11, 16)}` : "");
        return {
          summary: signing ? `${nextActivity.summary} · ${signing.label}` : nextActivity.summary,
          when: overdue ? `Overdue · ${label}` : label,
          overdue,
        };
      })();

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
        noNextStep: lead._count.activities === 0 || overdue,
        ageDays: Math.floor((now.getTime() - lead.stageEnteredAt.getTime()) / 86400000),
        nextStep,
        testDrive: (() => {
          if (testDriveStage && stage.order < testDriveStage.order) return null;
          const testDrive = testDriveByLead.get(lead.id);
          if (!testDrive) return null;
          const saDate = new Date(testDrive.dueDate.getTime() + 2 * 60 * 60 * 1000);
          const dateKey = saDate.toISOString().slice(0, 10);
          const weather = forecast.get(dateKey);
          const hasTime = testDrive.dueDate.getUTCHours() !== 0 || testDrive.dueDate.getUTCMinutes() !== 0;
          return {
            when:
              saDate.toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short" }) +
              (hasTime ? ` ${saDate.toISOString().slice(11, 16)}` : ""),
            weather: weather
              ? `${weather.icon} ${weather.maxTemp}°${weather.rainChance >= 30 ? ` · ${weather.rainChance}% rain` : ""}`
              : null,
            date: dateKey,
          };
        })(),
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
      <PageHeader title="Leads" description={`${openCount} open · ${formatZAR(totalOpenValue)} in pipeline`}>
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
