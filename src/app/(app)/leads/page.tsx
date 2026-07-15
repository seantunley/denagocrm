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

  // The test-drive booking belongs to the test-drive stage. If a lead is moved
  // back BEFORE that stage (e.g. booked by mistake), don't keep showing the date
  // + weather on its card — even if a stale planned activity lingers. moveLead
  // also cancels the booking on move-back; this is the belt-and-braces display side.
  const testDriveStage = stages.find((s) => /test/i.test(s.name)) ?? null;

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
