import "server-only";
import { prisma } from "@/lib/db";
import { contactName } from "@/lib/format";
import { loadTodayLeads } from "@/lib/leadScoreLoader";
import { loadAttentionList } from "@/lib/attention/load";
import { getEnabledModuleIds } from "@/lib/modules/enabled";
import {
  getAccessibleCaseIds,
  getAccessibleJobCardIds,
  getAccessibleQuoteIds,
  hasAnyPermission,
  type PermissionUser,
} from "@/lib/permissions";
import { pendingApprovalsFor } from "@/lib/signing/access";
import { stageMeta } from "@/lib/workshop-constants";
import type { WorkItem } from "./rules";

/**
 * Everything waiting on this person, read from the records themselves. Each source
 * is gated by its module AND the permission its own page asks for, then narrowed
 * to the ids that page would list and to rows assigned to this person — so My Work
 * never shows a row the person could not open on its own page.
 */

const DAY = 24 * 60 * 60 * 1000;
/** Planned work this far ahead is "coming up"; further out is the calendar's job. */
const LOOKAHEAD_DAYS = 7;
/** A display limit per source, so one busy source cannot make the page unbounded. */
const PER_SOURCE = 50;

const within = (ids: string[] | null) => (ids === null ? {} : { id: { in: ids } });
type Person = { firstName: string; lastName: string | null; company: string | null; isCompany: boolean };
const PERSON = { select: { firstName: true, lastName: true, company: true, isCompany: true } } as const;

export async function loadMyWork(user: PermissionUser, now: Date = new Date()): Promise<WorkItem[]> {
  const modules = await getEnabledModuleIds();
  const lists = await Promise.all([
    salesDeals(user, now),
    myActivities(user, now),
    quotesAwaitingSignature(user),
    modules.has("automotive") ? myDeliveries(user) : [],
    modules.has("automotive") ? myJobCards(user) : [],
    modules.has("support") ? myCases(user) : [],
    myApprovals(user),
  ]);
  return lists.flat();
}

/** Today's own ranking of my deals — the same list /today shows under "Mine". */
async function salesDeals(user: PermissionUser, now: Date): Promise<WorkItem[]> {
  if (!(await hasAnyPermission(user, "leads.view_all", "leads.view_owned"))) return [];
  const { leads } = await loadTodayLeads(user, { mine: true }, now);
  return leads.slice(0, PER_SOURCE).map((lead) => ({
    area: "Sales",
    source: { type: "lead", id: lead.id },
    kind: "suggestion",
    title: lead.name,
    reason: lead.reasons.join(" · ") || "Worth contacting today",
    due: now,
    allDay: true,
    href: `/leads/${lead.id}`,
  }));
}

async function myActivities(user: PermissionUser, now: Date): Promise<WorkItem[]> {
  if (!(await hasAnyPermission(user, "activities.view", "activities.manage"))) return [];
  const rows = await prisma.activity.findMany({
    where: {
      assignedToId: user.id,
      status: "planned",
      availabilityBlock: false,
      dueDate: { lte: new Date(now.getTime() + LOOKAHEAD_DAYS * DAY) },
    },
    select: { id: true, type: true, summary: true, dueDate: true, allDay: true, leadId: true, contactId: true },
    orderBy: { dueDate: "asc" },
    take: PER_SOURCE,
  });
  return rows.map((row) => ({
    area: "Sales",
    source: { type: "activity", id: row.id },
    kind: "task",
    title: row.summary,
    reason: `Planned ${row.type === "todo" ? "task" : row.type}`,
    due: row.dueDate,
    allDay: row.allDay,
    href: row.leadId ? `/leads/${row.leadId}` : row.contactId ? `/contacts/${row.contactId}` : "/activities",
  }));
}

/** Quotes on my deals sent to the customer and not signed yet: mine, but the customer's move. */
async function quotesAwaitingSignature(user: PermissionUser): Promise<WorkItem[]> {
  if (!(await hasAnyPermission(user, "quotes.view_all", "quotes.view_owned"))) return [];
  const quoteIds = await getAccessibleQuoteIds(user);
  const rows = await prisma.quote.findMany({
    where: { ...within(quoteIds), status: "sent", signedAt: null, supersededAt: null, deletedAt: null, lead: { assignedToId: user.id } },
    select: { id: true, number: true, validUntil: true, contact: PERSON },
    orderBy: { sentAt: "asc" },
    take: PER_SOURCE,
  });
  return rows.map((row) => ({
    area: "Sales",
    source: { type: "quote", id: row.id },
    kind: "suggestion",
    title: `${who(row.contact)} · Q-${row.number}`,
    reason: "Sent — waiting for the customer to sign",
    due: row.validUntil,
    allDay: true,
    waiting: true,
    href: `/quotes/${row.id}`,
  }));
}

/** Signed deals of mine that have not been handed over yet. */
async function myDeliveries(user: PermissionUser): Promise<WorkItem[]> {
  if (!(await hasAnyPermission(user, "deliveries.view", "deliveries.manage"))) return [];
  const quoteIds = await getAccessibleQuoteIds(user);
  const rows = await prisma.quote.findMany({
    where: { ...within(quoteIds), status: "accepted", deliveredAt: null, supersededAt: null, deletedAt: null, lead: { assignedToId: user.id } },
    select: { id: true, number: true, deliveryScheduledFor: true, contact: PERSON },
    orderBy: { deliveryScheduledFor: { sort: "asc", nulls: "last" } },
    take: PER_SOURCE,
  });
  return rows.map((row) => ({
    area: "Deliveries",
    source: { type: "delivery", id: row.id },
    kind: "task",
    title: `${who(row.contact)} · Q-${row.number}`,
    reason: row.deliveryScheduledFor ? "Delivery booked" : "Signed — no delivery date yet",
    due: row.deliveryScheduledFor,
    allDay: true,
    href: "/deliveries",
  }));
}

async function myJobCards(user: PermissionUser): Promise<WorkItem[]> {
  if (!(await hasAnyPermission(user, "jobcards.view_all", "jobcards.view_owned"))) return [];
  const jobIds = await getAccessibleJobCardIds(user);
  const rows = await prisma.jobCard.findMany({
    where: { ...within(jobIds), technicianId: user.id, deletedAt: null, status: { notIn: ["collected", "cancelled"] } },
    select: { id: true, number: true, status: true, priority: true, contact: PERSON },
    orderBy: { openedAt: "asc" },
    take: PER_SOURCE,
  });
  return rows.map((row) => ({
    area: "Workshop",
    source: { type: "jobcard", id: row.id },
    kind: "task",
    title: `JC-${row.number} · ${who(row.contact)}`,
    reason: `At ${stageMeta(row.status).label}`,
    due: null,
    urgent: row.priority === "urgent",
    href: `/jobcards/${row.id}`,
  }));
}

/** Open cases on me; the ones pending the customer are listed as waiting. */
async function myCases(user: PermissionUser): Promise<WorkItem[]> {
  if (!(await hasAnyPermission(user, "cases.view_all", "cases.view_owned"))) return [];
  const caseIds = await getAccessibleCaseIds(user);
  const rows = await prisma.customerCase.findMany({
    where: { ...within(caseIds), assignedToId: user.id, closedAt: null, status: { in: ["new", "open", "waiting_internal", "waiting_customer"] } },
    select: { id: true, number: true, subject: true, status: true, priority: true },
    orderBy: { createdAt: "asc" },
    take: PER_SOURCE,
  });
  return rows.map((row) => ({
    area: "Support",
    source: { type: "case", id: row.id },
    kind: "task",
    title: `#${row.number} · ${row.subject}`,
    reason: row.status === "new" ? "New case" : row.status === "waiting_customer" ? "Waiting for the customer" : "Waiting on us",
    due: null,
    waiting: row.status === "waiting_customer",
    urgent: row.priority === "urgent",
    href: `/cases/${row.id}`,
  }));
}

/**
 * Approvals named for me. pendingApprovalsFor is the Signatures page's own rule;
 * for an owner it returns every pending step (an owner MAY decide any), so this
 * keeps only the ones actually addressed to me — or to "the owner".
 */
async function myApprovals(user: PermissionUser): Promise<WorkItem[]> {
  if (!(await hasAnyPermission(user, "signing.view", "signing.manage"))) return [];
  const steps = await pendingApprovalsFor(user);
  return steps
    .filter((step) => (step.assigneeType === "owner" ? user.role === "owner" : step.assigneeType === "staff" && step.assigneeUserId === user.id))
    .slice(0, PER_SOURCE)
    .map((step) => ({
      area: "Approvals",
      source: { type: "approval", id: step.id },
      kind: "task",
      title: step.request.title,
      reason: `Approve: ${step.label}`,
      due: null,
      href: `/signatures/${step.request.id}`,
    }));
}

const who = (contact: Person | null) => (contact ? contactName(contact) : "Customer");

/**
 * My deals the Attention Centre says need acting on — its own list, narrowed to
 * deals I own, worst first, with its reasons. Cached per request by the loader.
 */
export async function myDealsAtRisk(user: PermissionUser, now: Date, limit = 3) {
  if (!(await hasAnyPermission(user, "leads.view_all", "leads.view_owned"))) return [];
  const { leads } = await loadAttentionList(user, now);
  return leads
    .filter((lead) => lead.ownerId === user.id && (lead.band === "act" || lead.band === "urgent"))
    .slice(0, limit)
    .map((lead) => ({ id: lead.id, name: lead.name, band: lead.band, reason: lead.signals[0]?.detail ?? "" }));
}
