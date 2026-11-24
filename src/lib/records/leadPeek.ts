import "server-only";
import { prisma } from "@/lib/db";
import { actingTenantId } from "@/lib/actingTenant";
import { getAccessibleActivityIds } from "@/lib/activityAccess";
import { getCompanyProfile } from "@/lib/companyProfile";
import { isSmtpConfigured } from "@/lib/email";
import { scoreLeads } from "@/lib/leadScoreLoader";
import { canAccessContact, canAccessLead, hasPermission, type PermissionKey, type PermissionUser } from "@/lib/permissions";
import { listPipelineStages } from "@/lib/pipelines";
import { listActingTenantStaff } from "@/lib/tenantActor";
import { addWorkingDays, defaultChannel, nextStepDefault, todayChannels, todayDrafts, type ChannelState, type TodayChannel } from "@/lib/todayAction";
import { isWhatsAppConfigured } from "@/lib/whatsapp";
import { getRegionalSettings } from "@/lib/settings";
import { formatDate, formatDue, formatZAR } from "@/lib/format";
import { withCurrency } from "@/lib/currencyRules";
import { bucketOf } from "@/lib/myWork/rules";
import { availableActions, RECORD_ACTIONS, type ActionId } from "./actions";

/**
 * A deal, as the contextual drawer shows it (wave 2, W2-01/W2-03). Read on demand,
 * one record at a time, only after the workspace and the person's access to THIS
 * lead are checked — a lead id from the URL grants nothing. Only fields the full
 * lead page already shows this person are returned; the customer's contact details
 * only when they may open that customer (the rule Today uses).
 *
 * Everything the drawer can DO is an existing server action that checks again
 * (lib/records/actions.ts). This only decides what to offer.
 */

export type PeekActivity = { id: string; type: string; summary: string; when: string; overdue: boolean; owner: string | null; mine: boolean };

export type LeadPeek = {
  type: "lead";
  id: string;
  name: string;
  opportunity: string | null;
  /** In the deal's own currency, formatted by the workspace's regional settings. Null when no value is set. */
  value: string | null;
  status: string;
  stage: { id: string; name: string };
  owner: { id: string; name: string } | null;
  /** Today's own ranking: why this deal is worth acting on now, and what to do. */
  score: number;
  reasons: string[];
  action: string;
  upNext: PeekActivity[];
  recent: PeekActivity[];
  actions: ActionId[];
  /** Open stages of this deal's own pipeline the drawer may move it to (stages with a workflow on entry are left to the full page). */
  stages: { id: string; name: string }[];
  staff: { id: string; name: string }[];
  contact: {
    channels: Record<TodayChannel, ChannelState>;
    initialChannel: TodayChannel;
    email: string | null;
    phone: string | null;
    drafts: { email: { subject: string; body: string }; whatsapp: string };
    nextStep: { date: string; summary: string } | null;
    retryDate: string;
  };
};

const UP_NEXT = 5;
const RECENT = 3;

export async function loadLeadPeek(user: PermissionUser, leadId: string, now = new Date()): Promise<LeadPeek | null> {
  if (!(await hasPermission(user, "leads.view_all")) && !(await hasPermission(user, "leads.view_owned"))) return null;
  if (!(await canAccessLead(user, leadId))) return null;
  const tenantId = await actingTenantId();
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, tenantId, deletedAt: null },
    select: {
      id: true,
      name: true,
      title: true,
      valueCents: true,
      currency: true,
      status: true,
      createdAt: true,
      stageEnteredAt: true,
      stage: { select: { id: true, name: true, isClosed: true, staleAfterDays: true, order: true, pipelineId: true } },
      assignedTo: { select: { id: true, name: true } },
      email: true,
      phone: true,
      contactId: true,
      contact: { select: { firstName: true, email: true, phone: true, whatsapp: true } },
    },
  });
  if (!lead) return null;

  const held = new Set<string>();
  const keys = [...new Set(RECORD_ACTIONS.flatMap((action) => action.permissions)), "activities.view"];
  await Promise.all(keys.map(async (key) => (await hasPermission(user, key as PermissionKey)) && held.add(key)));
  const actions = availableActions("lead", (key) => held.has(key));
  const seesActivities = held.has("activities.view") || held.has("activities.manage");

  const [scores, mayOpenCustomer, activityIds, smtp, whatsapp, company, stages, staff, sentQuote, lastWa, regional] = await Promise.all([
    scoreLeads([lead], now),
    lead.contactId ? canAccessContact(user, lead.contactId) : false,
    seesActivities ? getAccessibleActivityIds(user) : ([] as string[]),
    isSmtpConfigured(),
    isWhatsAppConfigured(),
    getCompanyProfile(),
    actions.includes("changeStage") && lead.status === "open" ? listPipelineStages(lead.stage.pipelineId) : [],
    actions.includes("assignOwner") ? listActingTenantStaff() : [],
    prisma.quote.findFirst({
      where: { tenantId, leadId: lead.id, deletedAt: null, status: "sent", signedAt: null, supersededAt: null },
      select: { number: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.communication.findFirst({
      where: { tenantId, type: "whatsapp", direction: "inbound", OR: [{ leadId: lead.id }, ...(lead.contactId ? [{ contactId: lead.contactId }] : [])] },
      select: { occurredAt: true },
      orderBy: { occurredAt: "desc" },
    }),
    getRegionalSettings(),
  ]);

  const activityScope = activityIds === null ? {} : { id: { in: activityIds } };
  const ACTIVITY = { id: true, type: true, summary: true, dueDate: true, doneAt: true, allDay: true, assignedTo: { select: { id: true, name: true } } } as const;
  const [planned, done] = seesActivities && (activityIds === null || activityIds.length > 0)
    ? await Promise.all([
        prisma.activity.findMany({
          where: { tenantId, leadId: lead.id, status: "planned", availabilityBlock: false, ...activityScope },
          select: ACTIVITY,
          orderBy: { dueDate: "asc" },
          take: UP_NEXT,
        }),
        prisma.activity.findMany({
          where: { tenantId, leadId: lead.id, status: "done", ...activityScope },
          select: ACTIVITY,
          orderBy: { doneAt: "desc" },
          take: RECENT,
        }),
      ])
    : [[], []];
  type ActivityRow = { id: string; type: string; summary: string; allDay: boolean; assignedTo: { id: string; name: string } | null };
  const toPeek = (row: ActivityRow, at: Date, planned: boolean): PeekActivity => ({
    id: row.id,
    type: row.type,
    summary: row.summary,
    when: row.allDay ? formatDate(at, regional) : formatDue(at, regional),
    // The same rule as My Work: an all-day item is late once its day has gone; a timed one once its time has.
    overdue: planned && bucketOf({ due: at, allDay: row.allDay }, now) === "overdue",
    owner: row.assignedTo?.name ?? null,
    mine: row.assignedTo?.id === user.id,
  });

  const scored = scores.get(lead.id);
  const customer = mayOpenCustomer ? lead.contact : null;
  const email = lead.email || customer?.email || null;
  const phone = lead.phone || customer?.whatsapp || customer?.phone || null;
  const action = scored?.action ?? "Check in";
  const channels = todayChannels({
    email,
    phone,
    lastWhatsAppInboundAt: lastWa?.occurredAt ?? null,
    canWriteRecord: held.has("contacts.edit") || held.has("leads.edit"),
    canWhatsApp: held.has("inbox.reply"),
    smtpConfigured: smtp,
    whatsappConfigured: whatsapp,
    now,
  });
  const quoteNumber = sentQuote?.number ?? null;

  return {
    type: "lead",
    id: lead.id,
    name: lead.name,
    opportunity: lead.title && lead.title !== lead.name ? lead.title : null,
    value: lead.valueCents > 0 ? formatZAR(lead.valueCents, withCurrency(regional, lead.currency)) : null,
    status: lead.status,
    stage: { id: lead.stage.id, name: lead.stage.name },
    owner: lead.assignedTo,
    score: scored?.score ?? 0,
    reasons: scored?.reasons ?? [],
    action,
    upNext: planned.map((row) => toPeek(row, row.dueDate, true)),
    recent: done.map((row) => toPeek(row, row.doneAt ?? row.dueDate, false)),
    actions,
    stages: stages.filter((stage) => !stage.isClosed && !stage.entryAction).map((stage) => ({ id: stage.id, name: stage.name })),
    staff: staff.map((person) => ({ id: person.id, name: person.name })),
    contact: {
      channels,
      initialChannel: defaultChannel(action, channels),
      email,
      phone,
      drafts: todayDrafts({
        action,
        firstName: customer?.firstName?.trim() || lead.name.trim().split(/\s+/)[0] || lead.name,
        opportunity: lead.title && lead.title !== lead.name ? lead.title : null,
        quoteNumber,
        senderFirstName: user.name.trim().split(/\s+/)[0] || user.name,
        company: company.name,
      }),
      nextStep: held.has("activities.manage") ? nextStepDefault(action, now, quoteNumber) : null,
      retryDate: addWorkingDays(now, 1),
    },
  };
}
