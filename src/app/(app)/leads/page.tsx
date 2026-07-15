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
  const [stages, products, contacts, users] = await Promise.all([
    prisma.pipelineStage.findMany({
      orderBy: { order: "asc" },
      include: {
        leads: {
          where: { status: "open", deletedAt: null },
          orderBy: { createdAt: "desc" }, // newest leads on top of every column
          include: {
            product: true,
            assignedTo: true,
            activities: {
              where: { status: "planned", type: "test_drive", dueDate: { gte: new Date() } },
              orderBy: { dueDate: "asc" },
              take: 1,
            },
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

  const forecast = await getDailyForecast();

  // Active signing requests for these leads' quotes → a "quote sent · waiting for
  // X" badge on the card. Clears automatically once signing completes or is voided.
  const leadIds = stages.flatMap((s) => s.leads.map((l) => l.id));
  const signingByLead = new Map<string, { label: string }>();
  if (leadIds.length) {
    const leadQuotes = await prisma.quote.findMany({
      where: { leadId: { in: leadIds }, deletedAt: null },
      select: { id: true, leadId: true },
    });
    const quoteToLead = new Map(leadQuotes.map((q) => [q.id, q.leadId]));
    const quoteIds = leadQuotes.map((q) => q.id);
    if (quoteIds.length) {
      const requests = await prisma.signatureRequest.findMany({
        where: { quoteId: { in: quoteIds }, deletedAt: null, status: { in: ["sent", "viewed", "in_progress"] } },
        orderBy: { updatedAt: "desc" },
        include: { recipients: { orderBy: { order: "asc" } } },
      });
      for (const req of requests) {
        const leadId = req.quoteId ? quoteToLead.get(req.quoteId) : null;
        if (!leadId || signingByLead.has(leadId)) continue; // most-recent request wins
        const next = req.recipients.find((r) => r.role !== "viewer" && r.status !== "signed" && r.status !== "declined");
        signingByLead.set(leadId, {
          label: next ? `Quote sent · waiting for ${next.name.split(" ")[0]}` : "Quote fully signed",
        });
      }
    }
  }

  const boardStages: KanbanStage[] = stages.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
    leads: s.leads.map((l) => ({
      id: l.id,
      title: l.title,
      name: l.name,
      valueCents: l.valueCents,
      quantity: l.quantity,
      source: l.source,
      color: l.color,
      productId: l.productId,
      productName: l.product?.name ?? null,
      assignee: l.assignedTo?.name ?? null,
      research: l.research,
      isNew: !l.viewedAt && l.createdAt.getTime() > Date.now() - 3 * 24 * 60 * 60 * 1000,
      noNextStep: l._count.activities === 0,
      ageDays: Math.floor((Date.now() - l.stageEnteredAt.getTime()) / 86400000),
      testDrive: (() => {
        // Hide the booking once the lead is parked before the test-drive stage.
        if (testDriveStage && s.order < testDriveStage.order) return null;
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
          date: dateKey,
        };
      })(),
      signing: signingByLead.get(l.id) ?? null,
    })),
  }));

  const openCount = boardStages.reduce((n, s) => n + s.leads.length, 0);
  const totalOpenValue = boardStages.reduce(
    (n, s) => n + s.leads.reduce((a, l) => a + l.valueCents, 0),
    0
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
            variant="dialog"
          />
        </ModalTrigger>
      </PageHeader>
      <KanbanBoard
        stages={boardStages}
        products={products.map((p) => ({ id: p.id, name: p.name }))}
      />
    </div>
  );
}
