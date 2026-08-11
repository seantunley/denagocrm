import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";
import { requireUser, requireTenantOwner } from "./auth";
import { requireModuleEnabled } from "./modules/enabled";
import { actingScopeClass } from "./actingScope";
import { TenantScopeError } from "./tenantGuard";
import { governingDocumentLink } from "./documents/governing";
import {
  RBAC_INITIALIZED,
  RBAC_UNAVAILABLE,
  getUserPermissions,
  usablePermissions,
} from "./permissionQuery";
import { ROUTE_RULES, ruleFor, type GuardedRoute } from "./routeAccess";

export { getUserPermissions } from "./permissionQuery";

export const PERMISSIONS = [
  "pipelines.view", "pipelines.manage", "forecast.view", "forecast.manage",
  "leads.view_all", "leads.view_owned", "leads.create", "leads.edit", "leads.assign",
  "leads.change_stage", "leads.change_pipeline", "leads.mark_won", "leads.mark_lost",
  "leads.reopen", "leads.link_contact", "leads.delete",
  "contacts.view_all", "contacts.view_owned", "contacts.create", "contacts.edit",
  "contacts.delete", "contacts.merge",
  "quotes.view_all", "quotes.view_owned", "quotes.create", "quotes.edit",
  "quotes.change_status", "quotes.delete",
  "documents.view_all", "documents.view_owned", "documents.upload", "documents.manage",
  "document_templates.manage",
  "signing.view", "signing.manage",
  "docbuilder.view", "docbuilder.manage",
  "cases.view_all", "cases.view_owned", "cases.reply", "cases.manage",
  "cases.assign", "cases.create",
  "campaigns.view", "campaigns.manage", "campaigns.create", "campaigns.edit",
  "campaigns.review", "campaigns.approve", "campaigns.schedule", "campaigns.send",
  "campaigns.pause", "campaigns.cancel", "campaigns.archive", "campaigns.retry",
  "campaigns.test_send", "campaigns.manage_audiences", "campaigns.manage_templates",
  "surveys.view", "surveys.manage",
  "vehicles.view_all", "vehicles.view_owned", "vehicles.manage",
  "jobcards.view_all", "jobcards.view_owned", "jobcards.manage",
  "parts.view", "parts.manage", "warranty.view", "warranty.manage",
  "fleets.view", "fleets.manage", "stock.view", "stock.manage",
  "library.view", "library.manage", "activities.view", "activities.manage",
  "inbox.view", "inbox.reply", "deliveries.view", "deliveries.manage",
  "referrals.view", "referrals.manage",
  "reports.view", "reports.view_all", "reports.view_team",
  "portal_access.manage", "privacy.export",
  "teams.view", "teams.manage", "roles.view", "roles.manage",
  "audit.view", "audit.export", "journeys.manage", "workshop.manage",
  "competitors.view", "competitors.manage", "competitors.review", "competitors.research",
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number];
/**
 * `modules` deliberately absent: the per-user module CSV was the second,
 * conflicting authorization system this file's guards now replace. See
 * routeAccess.ts.
 */
export type PermissionUser = {
  id: string;
  name: string;
  email: string;
  role: string;
};

export async function getUserPermissionList(user: PermissionUser): Promise<string[]> {
  if (user.role === "owner") return [...PERMISSIONS];
  return [...usablePermissions(await getUserPermissions(user.id))];
}

export async function hasPermission(user: PermissionUser, permission: PermissionKey): Promise<boolean> {
  if (user.role === "owner") return true;
  const permissions = await getUserPermissions(user.id);
  return !permissions.has(RBAC_UNAVAILABLE) && permissions.has(RBAC_INITIALIZED) && permissions.has(permission);
}

export async function hasAnyPermission(user: PermissionUser, ...permissions: PermissionKey[]): Promise<boolean> {
  if (user.role === "owner") return true;
  const granted = await getUserPermissions(user.id);
  return !granted.has(RBAC_UNAVAILABLE) && granted.has(RBAC_INITIALIZED) && permissions.some((permission) => granted.has(permission));
}

export async function requirePermission(permission: PermissionKey): Promise<PermissionUser> {
  const user = await requireUser();
  if (!(await hasPermission(user, permission))) redirect("/");
  return user;
}

export async function requireAnyPermission(...permissions: PermissionKey[]): Promise<PermissionUser> {
  const user = await requireUser();
  if (!(await hasAnyPermission(user, ...permissions))) redirect("/");
  return user;
}

/**
 * The page/action side of the SAME rule the proxy applies at the edge — both
 * read ROUTE_RULES, so a route can no longer be allowed by one and refused by
 * the other. (That disagreement was the bug: the proxy consulted a per-user
 * module CSV that RBAC never wrote to, so granting a permission changed the page
 * guard's answer and not the proxy's.)
 *
 * This is the authoritative check: it resolves live RBAC on every request, while
 * the edge only holds the grant claim minted at sign-in.
 */
export async function requireRoute(route: GuardedRoute): Promise<PermissionUser> {
  const rule = ruleFor(route);
  // Unreachable — GuardedRoute is derived from ROUTE_RULES — but a rule that
  // cannot be found must deny, never wave the request through.
  if (!rule) redirect("/");
  if ("owner" in rule) {
    const user = await requireUser();
    if (user.role !== "owner") redirect("/");
    return user;
  }
  // The authoritative half of a `tenantOwner` rule. This resolves
  // Tenant.ownerUserId live on every request, so a person who stopped being
  // their workspace's owner loses the screen here even while an unexpired token
  // still carries the grant the edge reads.
  if ("tenantOwner" in rule) return requireTenantOwner();
  return requireAnyPermission(...rule.anyOf);
}

/** Every guarded prefix, for tests and tooling that inventory the surface. */
export const GUARDED_ROUTES = ROUTE_RULES.map((rule) => rule.prefix);

/**
 * "May READ customer records at all" — the RBAC replacement for the legacy
 * crm/workshop module flags on actions that touch a contact or a lead without
 * being scoped to one entity type (AI helpers, duplicate lookup). Spread it into
 * `requireAnyPermission`; the record-level `canAccessContact`/`canAccessLead`
 * checks at each call site still decide WHICH records.
 *
 * READ-GRADE ONLY. Every key here is a *view* permission, and this list must
 * never gate an action that writes. It used to: logging a communication,
 * deleting one, toggling a timeline pin and SENDING EMAIL were all gated on this
 * list, so a user holding nothing but contacts.view_owned could write to the
 * timeline and send mail from the workspace's address. Use
 * CUSTOMER_RECORD_WRITE_PERMISSIONS for anything that mutates or sends.
 */
export const CUSTOMER_RECORD_READ_PERMISSIONS = [
  "contacts.view_all",
  "contacts.view_owned",
  "leads.view_all",
  "leads.view_owned",
] as const satisfies readonly PermissionKey[];

/**
 * "May WRITE on a customer record" — the write-grade counterpart, for actions
 * that record, delete or send something against a contact or a lead without
 * being scoped to one entity type.
 *
 * `contacts.edit` / `leads.edit` are the existing catalogue keys for "may change
 * this record", and they are already what the sibling single-entity actions
 * demand: `toggleContactNotePin` requires contacts.edit and `toggleLeadNotePin`
 * requires leads.edit to pin the very same timeline these actions write to. No
 * narrower key fits — contacts.delete / leads.delete mean destroying the customer
 * record itself, not removing one entry from its history, and campaigns.send is
 * the bulk-marketing surface, not a rep emailing one customer.
 *
 * As with the read list, this only answers "at all"; canAccessContact /
 * canAccessLead at each call site still decide WHICH records.
 */
export const CUSTOMER_RECORD_WRITE_PERMISSIONS = [
  "contacts.edit",
  "leads.edit",
] as const satisfies readonly PermissionKey[];

export async function getUserTeamIds(userId: string): Promise<string[]> {
  try {
    const scope = await actingScopeClass();
    if (scope.mode === "closed") return [];
    // Reused in both UNION branches: each is an independent SELECT with exactly
    // one table in its FROM clause (tm, then t), so the unqualified column name
    // resolves against that branch's own table without ambiguity either time.
    const tenantFilter = scope.mode === "tenant" ? Prisma.sql`AND "tenantId" = ${scope.tenantId}` : Prisma.empty;
    const rows = await basePrisma.$queryRaw<Array<{ teamId: string }>>`
      SELECT DISTINCT scope."teamId"
      FROM (
        SELECT tm."teamId" FROM "TeamMember" tm WHERE tm."userId" = ${userId} ${tenantFilter}
        UNION
        SELECT t."id" AS "teamId" FROM "Team" t
        WHERE t."managerId" = ${userId} AND t."active" = true AND t."deletedAt" IS NULL ${tenantFilter}
      ) scope
    `;
    return rows.map((row) => row.teamId);
  } catch {
    return [];
  }
}

async function scopePermissions(user: PermissionUser): Promise<Set<string> | null> {
  if (user.role === "owner") return null;
  const permissions = await getUserPermissions(user.id);
  if (permissions.has(RBAC_UNAVAILABLE) || !permissions.has(RBAC_INITIALIZED)) return new Set();
  return permissions;
}

/**
 * The active tenant for a USER-ORIGINATED record resolve, as an explicit `where`
 * fragment for the handful of single-record lookups below that run on
 * `basePrisma` and so bypass RLS.
 *
 * `activeTenantPredicate` (tenantPredicate.ts) answers from ENFORCEMENT alone,
 * which is `{}` while DORMANT — the mode every environment runs in today. Every
 * canAccess* resolve step below used it, so the lookup matched ANY tenant's row
 * by id, and a "_view_all" holder (whose id list is `null`) sailed straight
 * through: `ids === null || ids.includes(id)` is true for an id that was never
 * screened at all. This resolves the ACTING workspace instead — enforced scope,
 * else the validated session workspace — so the same check that will hold once
 * enforcement flips already holds now. See tenantActor.ts for the sibling
 * reasoning applied to actor/staff resolution.
 *
 * `global` (no session-resolvable tenant) falls back to `{}`, matching today's
 * pre-tenancy behaviour — unreachable in practice here since every caller already
 * holds a `PermissionUser`, i.e. passed `requireUser`. `closed` throws, the same
 * refusal `activeTenantPredicate` already gives for an enforced request with no
 * usable scope.
 */
async function actingRecordPredicate(context: string): Promise<{ tenantId?: string | null }> {
  const scope = await actingScopeClass();
  if (scope.mode === "tenant") return { tenantId: scope.tenantId };
  if (scope.mode === "closed") {
    throw new TenantScopeError(
      `${context}: tenant enforcement is on but this request has no tenant scope. ` +
        "A global owner without a resolved tenant must use the platform console, " +
        "not tenant-scoped data.",
    );
  }
  return {};
}

/**
 * {@link actingRecordPredicate} for a LIST query instead of a single resolve.
 * `null` means fail closed — the caller must return an empty list, not run the
 * query unfiltered — which is the safe answer for the `closed` case on a surface
 * that renders a page rather than a single lookup a caller can afford to have
 * throw. `{}` (no `tenantId` key) for `global`, same pre-tenancy fallback as
 * above; `{ tenantId }` for a resolved workspace.
 */
async function actingListScope(): Promise<{ tenantId?: string } | null> {
  const scope = await actingScopeClass();
  if (scope.mode === "closed") return null;
  return scope.mode === "tenant" ? { tenantId: scope.tenantId } : {};
}

/* Leads use raw SQL because teamId was introduced through an additive migration
 * and intentionally is not part of the legacy Prisma Lead model. */
export async function getAccessibleLeadIds(user: PermissionUser): Promise<string[] | null> {
  const permissions = await scopePermissions(user);
  if (permissions === null || permissions.has("leads.view_all")) return null;
  if (!permissions.has("leads.view_owned")) return [];
  const scope = await actingScopeClass();
  if (scope.mode === "closed") return [];
  const leadTenant = scope.mode === "tenant" ? Prisma.sql`AND l."tenantId" = ${scope.tenantId}` : Prisma.empty;
  // Same reusable, unqualified fragment as getUserTeamIds — one table per branch.
  const teamTenant = scope.mode === "tenant" ? Prisma.sql`AND "tenantId" = ${scope.tenantId}` : Prisma.empty;
  const rows = await basePrisma.$queryRaw<Array<{ id: string }>>`
    SELECT l."id"
    FROM "Lead" l
    WHERE l."deletedAt" IS NULL
      ${leadTenant}
      AND (
        l."assignedToId" = ${user.id}
        OR l."createdById" = ${user.id}
        OR l."teamId" IN (
          SELECT tm."teamId" FROM "TeamMember" tm WHERE tm."userId" = ${user.id} ${teamTenant}
          UNION
          SELECT t."id" FROM "Team" t WHERE t."managerId" = ${user.id} AND t."deletedAt" IS NULL ${teamTenant}
        )
      )
  `;
  return rows.map((row) => row.id);
}

/**
 * May this user reach THIS lead?
 *
 * THE RULE FOR EVERY canAccess* HELPER IN THIS FILE, stated once here and
 * repeated in shape by each of them:
 *
 *   1. RESOLVE the record on `basePrisma` with an explicit tenant predicate.
 *   2. A miss is a REFUSAL.
 *   3. Only then consult the accessible-id list.
 *
 * Answering from the id list alone is what made these unsafe. A
 * getAccessible*Ids helper returns `null` for an unrestricted scope, and
 * `ids === null || ids.includes(id)` turns that into "true for ANY id at all" —
 * an id in another tenant, or an id that does not exist. "Unrestricted within my
 * tenant" is never "unrestricted", and `view_all` is a statement about how much
 * of MY workspace I may see, not about whose workspace it is.
 *
 * That mattered because these helpers are the only record-level gate in front of
 * writes that run on `basePrisma` and so bypass RLS — the same hole already
 * closed on canAccessDocument, where a documents.manage holder could soft-delete
 * another tenant's document by id. `basePrisma` is used deliberately here: the
 * scoped client would answer the tenant question by hiding the row, which reads
 * as "no such record" and leaves the predicate untested.
 *
 * Deliberately NOT filtered on `deletedAt` — same as canAccessDocument. Trash and
 * restore ask these helpers about rows that are already soft-deleted, and a
 * liveness filter here would refuse every restore. Liveness is the id list's job
 * (each getAccessible*Ids already filters it) and the mutation guard's.
 */
export async function canAccessLead(user: PermissionUser, leadId: string): Promise<boolean> {
  const lead = await basePrisma.lead.findFirst({
    where: { id: leadId, ...(await actingRecordPredicate("lead access check")) },
    select: { id: true },
  });
  if (!lead) return false;
  const ids = await getAccessibleLeadIds(user);
  return ids === null || ids.includes(leadId);
}

export async function requireLeadReadAccess(leadId: string): Promise<PermissionUser> {
  const user = await requireAnyPermission("leads.view_all", "leads.view_owned");
  if (!(await canAccessLead(user, leadId))) redirect("/leads");
  return user;
}

export async function requireLeadAccess(leadId: string, permission: PermissionKey): Promise<PermissionUser> {
  const user = await requirePermission(permission);
  if (!(await canAccessLead(user, leadId))) redirect("/leads");
  return user;
}

export async function getAccessibleLeadScope(user: PermissionUser): Promise<{
  viewAll: boolean;
  viewOwned: boolean;
  userId: string;
  teamIds: string[];
}> {
  if (user.role === "owner") return { viewAll: true, viewOwned: true, userId: user.id, teamIds: [] };
  const permissions = await getUserPermissions(user.id);
  if (permissions.has(RBAC_UNAVAILABLE) || !permissions.has(RBAC_INITIALIZED)) {
    return { viewAll: false, viewOwned: false, userId: user.id, teamIds: [] };
  }
  const viewAll = permissions.has("leads.view_all");
  const viewOwned = viewAll || permissions.has("leads.view_owned");
  return { viewAll, viewOwned, userId: user.id, teamIds: viewOwned ? await getUserTeamIds(user.id) : [] };
}

export async function getAccessibleContactIds(user: PermissionUser): Promise<string[] | null> {
  const permissions = await scopePermissions(user);
  if (permissions === null || permissions.has("contacts.view_all")) return null;
  if (!permissions.has("contacts.view_owned")) return [];
  const scope = await actingListScope();
  if (!scope) return [];
  const leadIds = await getAccessibleLeadIds(user);
  const rows = await basePrisma.contact.findMany({
    where: {
      deletedAt: null,
      ...scope,
      OR: [
        { ownerId: user.id },
        { createdById: user.id },
        { jobCards: { some: { technicianId: user.id, deletedAt: null } } },
        ...(leadIds === null
          ? [{ leads: { some: { deletedAt: null } } }]
          : leadIds.length
            ? [{ leads: { some: { id: { in: leadIds } } } }]
            : []),
      ],
    },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/** May this user reach THIS contact? Resolve-then-list — see canAccessLead. */
export async function canAccessContact(user: PermissionUser, contactId: string): Promise<boolean> {
  const contact = await basePrisma.contact.findFirst({
    where: { id: contactId, ...(await actingRecordPredicate("contact access check")) },
    select: { id: true },
  });
  if (!contact) return false;
  const ids = await getAccessibleContactIds(user);
  return ids === null || ids.includes(contactId);
}

/**
 * Social-inbox WHERE fragment scoping Communications to the contacts/leads a
 * user may see. Contacts and leads scope independently: a null id list from
 * either helper means "all of that type" (view_all / owner), which we express
 * as `{ … : { not: null } }` so a user privileged for one type still sees every
 * thread of that type — mirroring canAccessContact/canAccessLead, which the
 * per-thread actions already enforce. Both null → {} (no filter), so fully
 * privileged users are unchanged. Otherwise an OR over the accessible linkages;
 * an empty id list yields `in: []`, an impossible match, so a scoped user with
 * no accessible records leaks nothing.
 */
export async function accessibleInboxWhere(
  user: PermissionUser,
): Promise<Record<string, unknown>> {
  const [contactIds, leadIds] = await Promise.all([
    getAccessibleContactIds(user),
    getAccessibleLeadIds(user),
  ]);
  if (contactIds === null && leadIds === null) return {};
  return {
    OR: [
      contactIds === null ? { contactId: { not: null } } : { contactId: { in: contactIds } },
      leadIds === null ? { leadId: { not: null } } : { leadId: { in: leadIds } },
    ],
  };
}

/**
 * May this user act on THIS conversation?
 *
 * The per-thread guard the inbox never had. `accessibleInboxWhere` scopes the
 * LIST, so a scoped user cannot see a thread they have no record access to — but
 * nothing stopped them naming its id in an action. The original shared-inbox
 * Phase 2 assigned, noted and drafted against any conversation id a caller sent,
 * checking only that they held an inbox permission at all.
 *
 * Deliberately the same shape as accessibleInboxWhere rather than a new rule:
 * both null id lists means fully privileged, which that function expresses as no
 * filter, and a conversation is reachable through EITHER its contact or its lead.
 * A rule that disagreed with the list query would show a thread it then refused
 * to act on, or worse.
 */
export async function canAccessConversation(
  user: PermissionUser,
  conversationId: string,
): Promise<boolean> {
  // findFirst on basePrisma WITH the tenant predicate named, like every sibling.
  // basePrisma bypasses RLS, so a lookup by id alone would happily resolve another
  // tenant's conversation and then answer the permission question about it. The
  // scoped client is not the fix either: it would hide the row, which reads as
  // "no such conversation" and leaves the tenant check untested.
  const conversation = await basePrisma.conversation.findFirst({
    where: { id: conversationId, ...(await actingRecordPredicate("conversation access check")) },
    select: { contactId: true, leadId: true },
  });
  if (!conversation) return false;
  const [contactIds, leadIds] = await Promise.all([
    getAccessibleContactIds(user),
    getAccessibleLeadIds(user),
  ]);
  if (contactIds === null && leadIds === null) return true;
  if (conversation.contactId && (contactIds === null || contactIds.includes(conversation.contactId))) {
    return true;
  }
  if (conversation.leadId && (leadIds === null || leadIds.includes(conversation.leadId))) return true;
  // Neither linkage is reachable — including a thread attached to no record at
  // all, which a scoped user has no basis to act on.
  return false;
}

export async function requireConversationAccess(
  conversationId: string,
  permission: PermissionKey,
): Promise<PermissionUser> {
  const user = await requirePermission(permission);
  if (!(await canAccessConversation(user, conversationId))) redirect("/inbox");
  return user;
}

export async function requireContactReadAccess(contactId: string): Promise<PermissionUser> {
  const user = await requireAnyPermission("contacts.view_all", "contacts.view_owned");
  if (!(await canAccessContact(user, contactId))) redirect("/contacts");
  return user;
}

export async function requireContactAccess(contactId: string, permission: PermissionKey): Promise<PermissionUser> {
  const user = await requirePermission(permission);
  if (!(await canAccessContact(user, contactId))) redirect("/contacts");
  return user;
}

export async function getAccessibleQuoteIds(user: PermissionUser): Promise<string[] | null> {
  const permissions = await scopePermissions(user);
  if (permissions === null || permissions.has("quotes.view_all")) return null;
  if (!permissions.has("quotes.view_owned")) return [];
  const scope = await actingListScope();
  if (!scope) return [];
  const [leadIds, contactIds] = await Promise.all([getAccessibleLeadIds(user), getAccessibleContactIds(user)]);
  const rows = await basePrisma.quote.findMany({
    where: {
      deletedAt: null,
      ...scope,
      OR: [
        { createdById: user.id },
        ...(leadIds === null ? [{ leadId: { not: null } }] : leadIds.length ? [{ leadId: { in: leadIds } }] : []),
        ...(contactIds === null ? [{ contactId: { not: null } }] : contactIds.length ? [{ contactId: { in: contactIds } }] : []),
      ],
    },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/** May this user reach THIS quote? Resolve-then-list — see canAccessLead. */
export async function canAccessQuote(user: PermissionUser, quoteId: string): Promise<boolean> {
  const quote = await basePrisma.quote.findFirst({
    where: { id: quoteId, ...(await actingRecordPredicate("quote access check")) },
    select: { id: true },
  });
  if (!quote) return false;
  const ids = await getAccessibleQuoteIds(user);
  return ids === null || ids.includes(quoteId);
}

export async function requireQuoteReadAccess(quoteId: string): Promise<PermissionUser> {
  const user = await requireAnyPermission("quotes.view_all", "quotes.view_owned");
  if (!(await canAccessQuote(user, quoteId))) redirect("/quotes");
  return user;
}

export async function requireQuoteAccess(quoteId: string, permission: PermissionKey): Promise<PermissionUser> {
  const user = await requirePermission(permission);
  if (!(await canAccessQuote(user, quoteId))) redirect("/quotes");
  return user;
}

export async function getAccessibleVehicleIds(user: PermissionUser): Promise<string[] | null> {
  const permissions = await scopePermissions(user);
  if (permissions === null || permissions.has("vehicles.view_all")) return null;
  if (!permissions.has("vehicles.view_owned")) return [];
  const scope = await actingListScope();
  if (!scope) return [];
  const contactIds = await getAccessibleContactIds(user);
  if (contactIds === null) return null;
  const rows = await basePrisma.vehicle.findMany({
    where: {
      deletedAt: null,
      ...scope,
      OR: [
        ...(contactIds.length ? [{ contactId: { in: contactIds } }, { fleet: { contactId: { in: contactIds } } }] : []),
        { jobCards: { some: { technicianId: user.id, deletedAt: null } } },
      ],
    },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/** May this user reach THIS vehicle? Resolve-then-list — see canAccessLead. */
export async function canAccessVehicle(user: PermissionUser, vehicleId: string): Promise<boolean> {
  const vehicle = await basePrisma.vehicle.findFirst({
    where: { id: vehicleId, ...(await actingRecordPredicate("vehicle access check")) },
    select: { id: true },
  });
  if (!vehicle) return false;
  const ids = await getAccessibleVehicleIds(user);
  return ids === null || ids.includes(vehicleId);
}

export async function requireVehicleReadAccess(vehicleId: string): Promise<PermissionUser> {
  const user = await requireAnyPermission("vehicles.view_all", "vehicles.view_owned");
  if (!(await canAccessVehicle(user, vehicleId))) redirect("/vehicles");
  return user;
}

export async function requireVehicleAccess(vehicleId: string, permission: PermissionKey = "vehicles.manage"): Promise<PermissionUser> {
  // Vehicles are automotive-owned. Gating here — the single choke-point every
  // vehicle mutation and vehicle-targeted document action passes through — makes
  // the module a real server-side boundary rather than a per-action checklist:
  // with the pack off, no direct POST can drive vehicle data. Throws when off.
  await requireModuleEnabled("automotive");
  const user = await requirePermission(permission);
  if (!(await canAccessVehicle(user, vehicleId))) redirect("/vehicles");
  return user;
}

export async function getAccessibleJobCardIds(user: PermissionUser): Promise<string[] | null> {
  const permissions = await scopePermissions(user);
  if (permissions === null || permissions.has("jobcards.view_all")) return null;
  if (!permissions.has("jobcards.view_owned")) return [];
  const scope = await actingListScope();
  if (!scope) return [];
  const [contactIds, vehicleIds] = await Promise.all([getAccessibleContactIds(user), getAccessibleVehicleIds(user)]);
  if (contactIds === null || vehicleIds === null) return null;
  const rows = await basePrisma.jobCard.findMany({
    where: {
      deletedAt: null,
      ...scope,
      OR: [
        { technicianId: user.id },
        ...(contactIds.length ? [{ contactId: { in: contactIds } }] : []),
        ...(vehicleIds.length ? [{ vehicleId: { in: vehicleIds } }] : []),
      ],
    },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/** May this user reach THIS job card? Resolve-then-list — see canAccessLead. */
export async function canAccessJobCard(user: PermissionUser, jobCardId: string): Promise<boolean> {
  const jobCard = await basePrisma.jobCard.findFirst({
    where: { id: jobCardId, ...(await actingRecordPredicate("job card access check")) },
    select: { id: true },
  });
  if (!jobCard) return false;
  const ids = await getAccessibleJobCardIds(user);
  return ids === null || ids.includes(jobCardId);
}

export async function requireJobCardReadAccess(jobCardId: string): Promise<PermissionUser> {
  const user = await requireAnyPermission("jobcards.view_all", "jobcards.view_owned");
  if (!(await canAccessJobCard(user, jobCardId))) redirect("/jobcards");
  return user;
}

export async function requireJobCardAccess(jobCardId: string, permission: PermissionKey = "jobcards.manage"): Promise<PermissionUser> {
  // Job cards are automotive-owned; same central-gate reasoning as
  // requireVehicleAccess — every job-card edit and job-card-targeted document
  // action funnels through here, so the pack is enforced once. Throws when off.
  await requireModuleEnabled("automotive");
  const user = await requirePermission(permission);
  if (!(await canAccessJobCard(user, jobCardId))) redirect("/jobcards");
  return user;
}

/**
 * Document scope is the caller's own uploads plus every document whose GOVERNING
 * linked record they can reach — one record per document, chosen by precedence
 * (quote > job card > vehicle > contact). See lib/documents/governing.ts.
 *
 * It used to be a UNION over all four links, so a document reachable through any
 * one of them was reachable. Nearly every system-generated document also carries
 * the customer: the invoice, the delivery note and the signed contract for a
 * quote are all filed with `contactId` set alongside `quoteId`. Contact access
 * therefore handed over the quote's pricing and its terms. An unrestricted
 * contact/vehicle scope grants documents GOVERNED by that record type, never
 * documents that merely mention it.
 *
 * THE ONLY document scope in the app. A byte-for-byte second copy lived in
 * lib/documentAccess.ts and was split by CALLER — the write paths (actions/
 * documents.ts, signing/access.ts) used this one, while the read paths (the
 * documents list, global search, /api/files/[id]) used that one. Neither module
 * imported the other, so the two could drift and the app would answer "you may
 * open this file" and "you may not edit this file" from two independently
 * maintained rules. The download endpoint is the sharpest edge: it hands over
 * bytes, so a copy that fell behind there leaks the document itself. Anything
 * that needs a document-scope decision imports it from here.
 */
export async function getAccessibleDocumentIds(user: PermissionUser): Promise<string[] | null> {
  // scopePermissions, not two hasPermission() calls (what the deleted copy did):
  // one RBAC read decides both branches, so view_all and view_owned are answered
  // from the SAME snapshot and the query cost does not double.
  const permissions = await scopePermissions(user);
  if (permissions === null || permissions.has("documents.view_all")) return null;
  if (!permissions.has("documents.view_owned")) return [];
  const [contactIds, quoteIds, vehicleIds, jobCardIds] = await Promise.all([
    getAccessibleContactIds(user), getAccessibleQuoteIds(user), getAccessibleVehicleIds(user), getAccessibleJobCardIds(user),
  ]);
  const rows = await basePrisma.document.findMany({
    where: {
      deletedAt: null,
      // basePrisma BYPASSES the RLS extension, so the tenant predicate has to be
      // written by hand. Without it the `{ not: null }` arms below — reached
      // whenever a linked-record scope is unrestricted — select every
      // contact-linked document in EVERY tenant.
      ...(await documentTenantWhere()),
      // A PRE-FILTER, not the rule. This OR is the old union, kept only to bound
      // what comes back from the database: every document the precedence rule
      // admits is reachable through at least one link, so the union is a strict
      // superset and filtering it below can only ever remove rows. The decision
      // itself is made per row, against the ONE governing link.
      OR: [
        { uploadedById: user.id },
        ...(contactIds === null ? [{ contactId: { not: null } }] : contactIds.length ? [{ contactId: { in: contactIds } }] : []),
        ...(quoteIds === null ? [{ quoteId: { not: null } }] : quoteIds.length ? [{ quoteId: { in: quoteIds } }] : []),
        ...(vehicleIds === null ? [{ vehicleId: { not: null } }] : vehicleIds.length ? [{ vehicleId: { in: vehicleIds } }] : []),
        ...(jobCardIds === null ? [{ jobCardId: { not: null } }] : jobCardIds.length ? [{ jobCardId: { in: jobCardIds } }] : []),
      ],
    },
    select: { id: true, uploadedById: true, quoteId: true, jobCardId: true, vehicleId: true, contactId: true },
  });
  const reachable = {
    quote: idReach(quoteIds),
    jobcard: idReach(jobCardIds),
    vehicle: idReach(vehicleIds),
    contact: idReach(contactIds),
  } as const;
  return rows
    .filter((row) => {
      // "You uploaded it" stays an INDEPENDENT grant, deliberately. It is not
      // derived from a record, so precedence has nothing to say about it: the
      // uploader was already authorized against the target at upload time
      // (authorizeUploadTarget), and uploadRepoDocument files documents with no
      // link at all — take this grant away and the uploader loses the file the
      // instant they save it, with nobody short of documents.view_all able to
      // open it.
      if (row.uploadedById === user.id) return true;
      const link = governingDocumentLink(row);
      // No link means no governing record, which is a refusal — never a waiver.
      return link !== null && reachable[link.kind](link.id);
    })
    .map((row) => row.id);
}

/**
 * "Can this user reach that id?" for one record type. `null` from a
 * getAccessible*Ids helper means unrestricted, NOT an empty list — the two look
 * alike at a glance and confusing them either opens everything or closes it.
 */
function idReach(ids: string[] | null): (id: string) => boolean {
  if (ids === null) return () => true;
  const set = new Set(ids);
  return (id) => set.has(id);
}

/**
 * The active tenant, as an explicit predicate for a basePrisma document query.
 * A thin name for {@link actingRecordPredicate} — kept as its own function
 * because both call sites below read as "the document scope", not "the acting
 * record predicate, applied to a document".
 */
function documentTenantWhere(): Promise<{ tenantId?: string | null }> {
  return actingRecordPredicate("document scope");
}

/**
 * May this user reach THIS document?
 *
 * Resolves the document itself rather than answering from the id list. The list
 * returns `null` for an unrestricted scope, and `ids === null || ...` turned
 * that into "true for any id at all" — including an id belonging to another
 * tenant. Read surfaces mostly re-query through the scoped client and so were
 * protected by RLS, but `deleteDocument` writes through the trash helper on
 * `basePrisma`: a documents.manage holder could pass another tenant's document
 * id and soft-delete it. "Unrestricted within my tenant" is never "unrestricted".
 */
export async function canAccessDocument(user: PermissionUser, documentId: string): Promise<boolean> {
  const document = await basePrisma.document.findFirst({
    where: { id: documentId, ...(await documentTenantWhere()) },
    select: { id: true },
  });
  if (!document) return false;
  const ids = await getAccessibleDocumentIds(user);
  return ids === null || ids.includes(documentId);
}

export async function requireDocumentReadAccess(documentId: string): Promise<PermissionUser> {
  const user = await requireAnyPermission("documents.view_all", "documents.view_owned");
  if (!(await canAccessDocument(user, documentId))) redirect("/documents");
  return user;
}

export async function requireDocumentAccess(documentId: string, permission: PermissionKey = "documents.manage"): Promise<PermissionUser> {
  const user = await requirePermission(permission);
  if (!(await canAccessDocument(user, documentId))) redirect("/documents");
  return user;
}

export async function getAccessibleCaseIds(user: PermissionUser): Promise<string[] | null> {
  const permissions = await scopePermissions(user);
  if (permissions === null || permissions.has("cases.view_all")) return null;
  if (!permissions.has("cases.view_owned")) return [];
  const scope = await actingScopeClass();
  if (scope.mode === "closed") return [];
  // Parenthesised deliberately: AND binds tighter than OR, so appending the
  // tenant filter after an unparenthesised OR-chain would only apply it to the
  // LAST arm and leave the contact/vehicle arms unfiltered.
  const caseTenant = scope.mode === "tenant" ? Prisma.sql`AND c."tenantId" = ${scope.tenantId}` : Prisma.empty;
  const [contactIds, vehicleIds] = await Promise.all([getAccessibleContactIds(user), getAccessibleVehicleIds(user)]);
  if (contactIds === null) return null;
  // vehicleIds === null means the user can see ALL vehicles, so every vehicle-linked
  // case is accessible — not `= ANY([])`, which would drop them all.
  // A ticket is "owned" if it belongs to an accessible contact/vehicle OR is
  // assigned to this agent (so an agent always sees their own queue).
  const rows = vehicleIds === null
    ? await basePrisma.$queryRaw<Array<{ id: string }>>`
        SELECT c."id" FROM "CustomerCase" c
        WHERE (c."contactId" = ANY(${contactIds}::text[]) OR c."vehicleId" IS NOT NULL
           OR c."assignedToId" = ${user.id}) ${caseTenant}`
    : await basePrisma.$queryRaw<Array<{ id: string }>>`
        SELECT c."id" FROM "CustomerCase" c
        WHERE (c."contactId" = ANY(${contactIds}::text[])
           OR (c."vehicleId" IS NOT NULL AND c."vehicleId" = ANY(${vehicleIds}::text[]))
           OR c."assignedToId" = ${user.id}) ${caseTenant}`;
  return rows.map((row) => row.id);
}

/** May this user reach THIS case? Resolve-then-list — see canAccessLead. */
export async function canAccessCase(user: PermissionUser, caseId: string): Promise<boolean> {
  const supportCase = await basePrisma.customerCase.findFirst({
    where: { id: caseId, ...(await actingRecordPredicate("case access check")) },
    select: { id: true },
  });
  if (!supportCase) return false;
  const ids = await getAccessibleCaseIds(user);
  return ids === null || ids.includes(caseId);
}

export async function requireCaseReadAccess(caseId: string): Promise<PermissionUser> {
  const user = await requireAnyPermission("cases.view_all", "cases.view_owned");
  if (!(await canAccessCase(user, caseId))) redirect("/cases");
  return user;
}

export async function requireCaseAccess(caseId: string, permission: PermissionKey): Promise<PermissionUser> {
  const user = await requirePermission(permission);
  if (!(await canAccessCase(user, caseId))) redirect("/cases");
  return user;
}
