import "server-only";
import { Prisma } from "@prisma/client";
import { basePrisma } from "@/lib/db";
import { getAccessibleCaseIds, type PermissionUser } from "@/lib/permissions";
import { statusMeta, type Folder } from "@/lib/helpdesk-constants";

export type TicketTag = { name: string; color: string };

export type TicketListRow = {
  id: string;
  number: bigint;
  subject: string;
  type: string;
  priority: string;
  status: string;
  contactId: string;
  contactName: string;
  vehicleModel: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  mailboxName: string | null;
  mailboxColor: string | null;
  mailboxSlug: string | null;
  tags: TicketTag[];
  unread: bigint;
  lastReplyBy: string | null;
  lastMessageAt: Date | null;
  lastPreview: string | null;
  snoozedUntil: Date | null;
  updatedAt: Date;
};

export type TicketFilters = {
  folder?: Folder;
  mailboxSlug?: string | null;
  assignee?: string | null; // userId | "me" | "unassigned"
  tag?: string | null; // tag slug
  q?: string | null;
  type?: string | null;
};

const CONTACT_NAME = Prisma.sql`CASE WHEN contact."isCompany" AND contact."company" IS NOT NULL THEN contact."company" ELSE TRIM(CONCAT(contact."firstName", ' ', COALESCE(contact."lastName", ''))) END`;

/** Build the WHERE fragments shared by the list and the counts. */
function buildWhere(user: PermissionUser, accessibleIds: string[] | null, filters: TicketFilters): Prisma.Sql {
  const clauses: Prisma.Sql[] = [];
  clauses.push(accessibleIds === null ? Prisma.sql`TRUE` : Prisma.sql`c."id" = ANY(${accessibleIds}::text[])`);

  switch (filters.folder) {
    case "unassigned":
      clauses.push(Prisma.sql`c."assignedToId" IS NULL AND c."status" NOT IN ('resolved','closed','cancelled')`);
      break;
    case "mine":
      clauses.push(Prisma.sql`c."assignedToId" = ${user.id} AND c."status" NOT IN ('resolved','closed','cancelled')`);
      break;
    case "open":
      clauses.push(Prisma.sql`c."status" IN ('new','open','waiting_internal')`);
      break;
    case "pending":
      clauses.push(Prisma.sql`c."status" = 'waiting_customer'`);
      break;
    case "closed":
      clauses.push(Prisma.sql`c."status" IN ('resolved','closed','cancelled')`);
      break;
    default:
      break; // "all" / undefined → no status constraint
  }

  if (filters.mailboxSlug) clauses.push(Prisma.sql`mbx."slug" = ${filters.mailboxSlug}`);
  if (filters.type) clauses.push(Prisma.sql`c."type" = ${filters.type}`);
  if (filters.assignee === "unassigned") clauses.push(Prisma.sql`c."assignedToId" IS NULL`);
  else if (filters.assignee === "me") clauses.push(Prisma.sql`c."assignedToId" = ${user.id}`);
  else if (filters.assignee) clauses.push(Prisma.sql`c."assignedToId" = ${filters.assignee}`);
  if (filters.tag) {
    clauses.push(Prisma.sql`EXISTS (SELECT 1 FROM "CustomerCaseTag" ct JOIN "SupportTag" t ON t."id" = ct."tagId" WHERE ct."caseId" = c."id" AND t."slug" = ${filters.tag})`);
  }
  if (filters.q) {
    const like = `%${filters.q}%`;
    const asNumber = /^\d+$/.test(filters.q.trim()) ? BigInt(filters.q.trim()) : null;
    clauses.push(
      asNumber !== null
        ? Prisma.sql`(c."subject" ILIKE ${like} OR c."number" = ${asNumber})`
        : Prisma.sql`(c."subject" ILIKE ${like} OR c."description" ILIKE ${like})`,
    );
  }
  return Prisma.join(clauses, " AND ");
}

export async function listTickets(user: PermissionUser, filters: TicketFilters): Promise<TicketListRow[]> {
  const accessibleIds = await getAccessibleCaseIds(user);
  if (accessibleIds !== null && accessibleIds.length === 0) return [];
  const where = buildWhere(user, accessibleIds, filters);
  return basePrisma.$queryRaw<TicketListRow[]>`
    SELECT
      c."id", c."number", c."subject", c."type", c."priority", c."status",
      c."contactId", ${CONTACT_NAME} AS "contactName",
      vehicle."model" AS "vehicleModel",
      c."assignedToId" AS "assigneeId", assignee."name" AS "assigneeName",
      mbx."name" AS "mailboxName", mbx."color" AS "mailboxColor", mbx."slug" AS "mailboxSlug",
      c."lastReplyBy", c."snoozedUntil", c."updatedAt",
      (SELECT COUNT(*) FROM "CustomerCaseMessage" m WHERE m."caseId" = c."id" AND m."type" = 'customer' AND m."readAt" IS NULL) AS "unread",
      (SELECT m."createdAt" FROM "CustomerCaseMessage" m WHERE m."caseId" = c."id" AND m."type" IN ('customer','staff') ORDER BY m."createdAt" DESC LIMIT 1) AS "lastMessageAt",
      (SELECT LEFT(m."body", 140) FROM "CustomerCaseMessage" m WHERE m."caseId" = c."id" AND m."type" IN ('customer','staff') ORDER BY m."createdAt" DESC LIMIT 1) AS "lastPreview",
      COALESCE((SELECT json_agg(jsonb_build_object('name', t."name", 'color', t."color") ORDER BY t."name") FROM "CustomerCaseTag" ct JOIN "SupportTag" t ON t."id" = ct."tagId" WHERE ct."caseId" = c."id"), '[]') AS "tags"
    FROM "CustomerCase" c
    JOIN "Contact" contact ON contact."id" = c."contactId"
    LEFT JOIN "Vehicle" vehicle ON vehicle."id" = c."vehicleId"
    LEFT JOIN "User" assignee ON assignee."id" = c."assignedToId"
    LEFT JOIN "SupportMailbox" mbx ON mbx."id" = c."mailboxId"
    WHERE ${where}
    ORDER BY
      CASE c."status" WHEN 'new' THEN 0 WHEN 'open' THEN 1 WHEN 'waiting_internal' THEN 2 WHEN 'waiting_customer' THEN 3 ELSE 4 END,
      CASE c."priority" WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      c."updatedAt" DESC
    LIMIT 500`;
}

export type FolderCounts = { unassigned: number; mine: number; open: number; pending: number; closed: number };

export async function folderCounts(user: PermissionUser, base: TicketFilters): Promise<FolderCounts> {
  const accessibleIds = await getAccessibleCaseIds(user);
  if (accessibleIds !== null && accessibleIds.length === 0) {
    return { unassigned: 0, mine: 0, open: 0, pending: 0, closed: 0 };
  }
  // Counts respect the mailbox/type/tag/search filters but ignore folder.
  const scoped = { ...base, folder: undefined, assignee: undefined };
  const where = buildWhere(user, accessibleIds, scoped);
  const rows = await basePrisma.$queryRaw<Array<{
    unassigned: bigint; mine: bigint; open: bigint; pending: bigint; closed: bigint;
  }>>`
    SELECT
      COUNT(*) FILTER (WHERE c."assignedToId" IS NULL AND c."status" NOT IN ('resolved','closed','cancelled')) AS "unassigned",
      COUNT(*) FILTER (WHERE c."assignedToId" = ${user.id} AND c."status" NOT IN ('resolved','closed','cancelled')) AS "mine",
      COUNT(*) FILTER (WHERE c."status" IN ('new','open','waiting_internal')) AS "open",
      COUNT(*) FILTER (WHERE c."status" = 'waiting_customer') AS "pending",
      COUNT(*) FILTER (WHERE c."status" IN ('resolved','closed','cancelled')) AS "closed"
    FROM "CustomerCase" c
    LEFT JOIN "SupportMailbox" mbx ON mbx."id" = c."mailboxId"
    WHERE ${where}`;
  const r = rows[0];
  return {
    unassigned: Number(r?.unassigned ?? 0),
    mine: Number(r?.mine ?? 0),
    open: Number(r?.open ?? 0),
    pending: Number(r?.pending ?? 0),
    closed: Number(r?.closed ?? 0),
  };
}

export type ThreadItem = {
  id: string;
  type: string;
  direction: string;
  body: string;
  createdAt: Date;
  authorName: string | null;
  meta: unknown;
};

export type TicketDetail = {
  id: string;
  number: bigint;
  subject: string;
  description: string;
  type: string;
  category: string | null;
  priority: string;
  status: string;
  source: string;
  contactId: string;
  vehicleId: string | null;
  assigneeId: string | null;
  mailboxId: string | null;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
  closedAt: Date | null;
  lastReplyBy: string | null;
  snoozedUntil: Date | null;
  tags: { id: string; name: string; color: string; slug: string }[];
  thread: ThreadItem[];
};

/** Full ticket for the staff detail view (includes internal notes + events). */
export async function getTicketDetail(id: string): Promise<TicketDetail | null> {
  const ticket = await basePrisma.customerCase.findUnique({
    where: { id },
    include: { tags: { include: { tag: true } } },
  });
  if (!ticket) return null;

  const messages = await basePrisma.$queryRaw<ThreadItem[]>`
    SELECT m."id", m."type", m."direction", m."body", m."createdAt", m."meta",
      COALESCE(u."name", ${CONTACT_NAME}) AS "authorName"
    FROM "CustomerCaseMessage" m
    LEFT JOIN "User" u ON u."id" = m."userId"
    LEFT JOIN "Contact" contact ON contact."id" = m."contactId"
    WHERE m."caseId" = ${id}
    ORDER BY m."createdAt" ASC`;

  return {
    id: ticket.id,
    number: ticket.number,
    subject: ticket.subject,
    description: ticket.description,
    type: ticket.type,
    category: ticket.category,
    priority: ticket.priority,
    status: ticket.status,
    source: ticket.source,
    contactId: ticket.contactId,
    vehicleId: ticket.vehicleId,
    assigneeId: ticket.assignedToId,
    mailboxId: ticket.mailboxId,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    resolvedAt: ticket.resolvedAt,
    closedAt: ticket.closedAt,
    lastReplyBy: ticket.lastReplyBy,
    snoozedUntil: ticket.snoozedUntil,
    tags: ticket.tags.map((t) => ({ id: t.tag.id, name: t.tag.name, color: t.tag.color, slug: t.tag.slug })),
    thread: messages,
  };
}

export async function listMailboxes(activeOnly = true) {
  return basePrisma.supportMailbox.findMany({
    where: activeOnly ? { active: true } : {},
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

export async function listTags() {
  return basePrisma.supportTag.findMany({ orderBy: { name: "asc" } });
}

export async function listCannedReplies(mailboxId?: string | null) {
  return basePrisma.cannedReply.findMany({
    where: mailboxId ? { OR: [{ mailboxId }, { mailboxId: null }] } : {},
    orderBy: { title: "asc" },
  });
}

/** Mark inbound customer messages as read when staff opens the ticket. */
export async function markCustomerMessagesRead(caseId: string) {
  await basePrisma.$executeRaw`
    UPDATE "CustomerCaseMessage" SET "readAt" = COALESCE("readAt", CURRENT_TIMESTAMP)
    WHERE "caseId" = ${caseId} AND "type" = 'customer' AND "readAt" IS NULL`;
}

export { statusMeta };
