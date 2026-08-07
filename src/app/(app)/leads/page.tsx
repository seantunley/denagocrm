import Link from "next/link";
import { Prisma } from "@prisma/client";
import { Plus, List, Trophy, Download } from "lucide-react";
import { prisma } from "@/lib/db";
import {
  getAccessibleContactIds,
  getAccessibleLeadIds,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";
import { getDailyForecast } from "@/lib/weather";
import { listTenantStaff } from "@/lib/tenantActor";
import { getTimelinePins } from "@/lib/timelinePins";
import { stageJourneyNames } from "@/lib/journeyStageBadges";
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
  // A GUARD, not a render check. This is the leads surface, and it used to run on
  // whatever getCurrentUser() returned: any signed-in user — a workshop tech, a
  // finance clerk, someone whose leads permissions had been revoked — got the
  // entire open pipeline, every value and every assignee. Its own siblings already
  // demand these keys (/leads/list, /leads/closed, /leads/[id]) and the sidebar
  // only offers the link to someone holding one of them.
  //
  // Deliberately NOT a ROUTE_RULES entry. routeAllowed fails closed on tokens
  // minted before a rule existed (see routeAccess.ts), so adding "/leads" there
  // would bounce every already-signed-in rep off the busiest page in the product
  // until they signed out and back in. The page guard is the authoritative
  // boundary; the edge table is a pre-filter in front of it.
  const currentUser = await requireAnyPermission("leads.view_all", "leads.view_owned");
  const [
    accessibleLeadIds,
    accessibleContactIds,
    // Gate the Ads export link to the same permission the API route enforces
    // (owner or reports.view_all), so staff without it don't see a dead link.
    canExportAds,
    canChangeStage,
    canAssign,
    canManageActivities,
    canMarkWon,
    canMarkLost,
  ] = await Promise.all([
    getAccessibleLeadIds(currentUser),
    getAccessibleContactIds(currentUser),
    hasPermission(currentUser, "reports.view_all"),
    hasPermission(currentUser, "leads.change_stage"),
    hasPermission(currentUser, "leads.assign"),
    hasPermission(currentUser, "activities.manage"),
    hasPermission(currentUser, "leads.mark_won"),
    hasPermission(currentUser, "leads.mark_lost"),
  ]);
  const [stages, products, contacts, users, automationRulesByStage] = await Promise.all([
    prisma.pipelineStage.findMany({
      orderBy: { order: "asc" },
      include: {
        leads: {
          // `null` from getAccessibleLeadIds means unrestricted (owner or
          // leads.view_all) — spread nothing. An empty array means "no accessible
          // leads" and MUST become `in: []`, an impossible match, not an absent
          // filter. Same shape as /leads/list and /leads/closed.
          where: {
            status: "open",
            deletedAt: null,
            ...(accessibleLeadIds ? { id: { in: accessibleLeadIds } } : {}),
          },
          orderBy: { createdAt: "desc" },
          include: {
            product: true,
            assignedTo: true,
            contact: { select: { notes: true } },
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
    // Customer picker for the "New lead" dialog. Scoped too: unscoped it handed
    // 500 customer records to anyone who opened the board, including reps whose
    // contact grant is view_owned.
    prisma.contact.findMany({
      where: accessibleContactIds ? { id: { in: accessibleContactIds } } : {},
      orderBy: { firstName: "asc" },
      take: 500,
    }),
    listTenantStaff(),
    stageJourneyNames(),
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

  // PINNED notes for the card indicator. Keyed off real TimelinePin rows, not off
  // whether a note exists — nearly every lead carries some note text, so note
  // presence made the icon meaningless. Three sources count as a "pinned note":
  //   lead_note      → the lead's own original note was pinned
  //   contact_note   → the linked contact's original note was pinned
  //   communication  → an added timeline note (type "note") was pinned
  const contactIdsForPins = [
    ...new Set(
      stages.flatMap((stage) =>
        stage.leads.map((lead) => lead.contactId).filter((id): id is string => Boolean(id)),
      ),
    ),
  ];
  const notePins = leadIds.length
    ? await getTimelinePins([
        ...leadIds.map((id) => ({ kind: "lead_note" as const, itemId: id })),
        ...contactIdsForPins.map((id) => ({ kind: "contact_note" as const, itemId: id })),
      ])
    : [];
  const pinnedLeadNoteIds = new Set(
    notePins.filter((pin) => pin.kind === "lead_note").map((pin) => pin.itemId),
  );
  const pinnedContactNoteIds = new Set(
    notePins.filter((pin) => pin.kind === "contact_note").map((pin) => pin.itemId),
  );

  // Pinned timeline notes (Communication rows of type "note"). Joined in SQL so
  // this stays one query regardless of how many leads are on the board.
  type PinnedNoteRow = { leadId: string; body: string };
  const pinnedNoteRows = leadIds.length
    ? await prisma.$queryRaw<PinnedNoteRow[]>(Prisma.sql`
        SELECT c."leadId", c."body"
        FROM "TimelinePin" p
        JOIN "Communication" c ON c."id" = p."itemId"
        WHERE p."kind" = 'communication'
          AND c."type" = 'note'
          AND c."leadId" IN (${Prisma.join(leadIds)})
        ORDER BY p."pinnedAt" DESC
      `)
    : [];
  const pinnedNotesByLead = new Map<string, string[]>();
  for (const row of pinnedNoteRows) {
    const list = pinnedNotesByLead.get(row.leadId) ?? [];
    list.push(row.body);
    pinnedNotesByLead.set(row.leadId, list);
  }

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

  // The test-drive booking belongs to the stage configured to collect it; hide
  // it on cards parked before that stage.
  const testDriveStage =
    stages.find((stage) => stage.entryAction === "book_test_drive") ?? null;

  const boardStages: KanbanStage[] = stages.map((stage) => ({
    id: stage.id,
    name: stage.name,
    color: stage.color,
    entryAction: stage.entryAction ?? null,
    automationRules: automationRulesByStage.get(stage.id) ?? [],
    leads: stage.leads.map((lead) => {
      const nextActivity = nextActivityByLead.get(lead.id);
      const nextTestDrive = nextTestDriveByLead.get(lead.id);

      return {
        id: lead.id,
        title: lead.title,
        name: lead.name,
        contactId: lead.contactId,
        valueCents: lead.valueCents,
        quantity: lead.quantity,
        source: lead.source,
        color: lead.color,
        productId: lead.productId,
        productName: lead.product?.name ?? null,
        assignedToId: lead.assignedToId,
        assignee: lead.assignedTo?.name ?? null,
        research: lead.research,
        notes: [
          ...(pinnedLeadNoteIds.has(lead.id) && lead.notes?.trim()
            ? [{ label: "Pinned lead note", text: lead.notes }]
            : []),
          ...(lead.contactId &&
          pinnedContactNoteIds.has(lead.contactId) &&
          lead.contact?.notes?.trim()
            ? [{ label: "Pinned contact note", text: lead.contact.notes }]
            : []),
          ...(pinnedNotesByLead.get(lead.id) ?? []).map((text) => ({
            label: "Pinned note",
            text,
          })),
        ],
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
        {canExportAds && (
          <Button asChild variant="ghost" size="sm">
            <a
              href="/api/export/ads-conversions"
              download
              title="Won leads that came from a Google Ads click, as a CSV for Google Ads → Conversions → Uploads"
            >
              <Download className="size-4" />
              Ads export
            </a>
          </Button>
        )}
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
        users={users.map((user) => ({ id: user.id, name: user.name }))}
        permissions={{ canChangeStage, canAssign, canManageActivities, canMarkWon, canMarkLost }}
      />
    </div>
  );
}
