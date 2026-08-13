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
  // Move a lead past a stage rule set to BLOCK. Granted to nobody by default, so
  // on the day this ships a blocking stage is unbypassable for every non-owner —
  // deliberate, because a rule that anyone can wave through is not a rule. Tenant
  // owners bypass permission checks entirely (see hasPermission), so an owner can
  // never be locked out of their own board by a rule they wrote.
  "leads.override_stage_rules",
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

export async function requireRoute(route: GuardedRoute): Promise<PermissionUser> {
  const rule = ruleFor(route);
  if (!rule) redirect("/");
  if ("owner" in rule) {
    const user = await requireUser();
    if (user.role !== "owner") redirect("/");
    return user;
  }
  if ("tenantOwner" in rule) return requireTenantOwner();
  return requireAnyPermission(...rule.anyOf);
}

export const GUARDED_ROUTES = ROUTE_RULES.map((rule) => rule.prefix);

export const CUSTOMER_RECORD_READ_PERMISSIONS = [
  "contacts.view_all",
  "contacts.view_owned",
  "leads.view_all",
  "leads.view_owned",
] as const satisfies readonly PermissionKey[];

export const CUSTOMER_RECORD_WRITE_PERMISSIONS = [
  "contacts.edit",
  "leads.edit",
] as const satisfies readonly PermissionKey[];

export async function getUserTeamIds(userId: string): Promise<string[]> {
  try {
    const scope = await actingScopeClass();
    // Neither `closed` nor `global` may run this unfiltered. `global` used to
    // fall through to `Prisma.empty` — no predicate — which for an unresolvable
    // session (stale claim, or ambiguous across memberships) returned every
    // workspace's teams, and those ids then widen the lead scope and the reports
    // people-filter built on top of them.
    if (scope.mode !== "tenant") return [];
    const tenantFilter = Prisma.sql`AND "tenantId" = ${scope.tenantId}`;
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
 * Resolve the acting workspace for a bypass-client single-record lookup.
 *
 * `global` IS A REFUSAL, not a background job — see the long note on
 * {@link actingListScope}. Every caller here holds a `PermissionUser`, so a
 * session exists by construction; `global` means that session could not be
 * resolved to a workspace, and answering `{}` there hands an unfiltered
 * `basePrisma` lookup any tenant's record by id.
 */
async function actingRecordPredicate(context: string): Promise<{ tenantId: string }> {
  const scope = await actingScopeClass();
  if (scope.mode === "tenant") return { tenantId: scope.tenantId };
  throw new TenantScopeError(
    `${context}: this request has no resolvable workspace. A global owner without a ` +
      "resolved tenant must use the platform console; a session that cannot resolve one — " +
      "stale, or ambiguous across several memberships — must sign in again.",
  );
}

/**
 * Resolve the acting workspace for a bypass-client list query. `null` means
 * fail closed: the caller returns an empty list rather than querying.
 *
 * WHY `global` IS NOT `{}` ANY MORE. This returned `{}` — no filter — on the
 * reasoning that `global` means "cron / webhook / queue drain, which has no
 * session and predates tenancy". That is wrong for these helpers and it failed
 * OPEN in exactly the states that most need a boundary.
 *
 * While enforcement is DORMANT — every environment today — `actingScopeClass()`
 * answers `global` whenever the session cannot be resolved to a tenant at all:
 * a session minted before the `tid` claim existed, a claim gone stale after a
 * membership was removed or a tenant suspended, and — the one that matters —
 * a claim that became AMBIGUOUS because the user holds two or more active
 * memberships, which `honoredTenantClaim()` deliberately drops to null rather
 * than guess at. The moment a second workspace exists, that last case is
 * ordinary, not exotic.
 *
 * So a signed-in person in any of those states got no predicate at all, and
 * these lists back nearly every screen in the product. There is no legitimate
 * sessionless caller to preserve `{}` for: every one of these helpers takes a
 * `PermissionUser`, which only exists downstream of `requireUser`. Fail closed.
 */
async function actingListScope(): Promise<{ tenantId: string } | null> {
  const scope = await actingScopeClass();
  return scope.mode === "tenant" ? { tenantId: scope.tenantId } : null;
}

/* Leads use raw SQL because teamId is additive and not part of the legacy Prisma Lead model. */
export async function getAccessibleLeadIds(user: PermissionUser): Promise<string[] | null> {
  const permissions = await scopePermissions(user);
  const scope = await actingScopeClass();
  // AT THE TOP, BEFORE ANY BRANCH. This first read `if (scope.mode === "closed")
  // return []`, and the `!== "tenant"` guard sat inside the view_all branch
  // below — so a view_OWNED holder walked straight past it into the raw SQL
  // with both fragments built as `Prisma.empty`, i.e. no tenant predicate at
  // all. `[]`, not `null`: null from this helper means UNRESTRICTED to every
  // caller. Neither `closed` nor `global` may reach a query here.
  if (scope.mode !== "tenant") return [];
  // No ternary any more: the guard above narrows `scope` to a real workspace, so
  // there is no branch left in which these could be empty.
  const leadTenant = Prisma.sql`AND l."tenantId" = ${scope.tenantId}`;
  const teamTenant = Prisma.sql`AND "tenantId" = ${scope.tenantId}`;

  if (permissions === null || permissions.has("leads.view_all")) {
    // The predicate is written out rather than interpolated via `leadTenant`:
    // same SQL, but a fragment carries the tenant past the access sweep, which
    // reads the statement text.
    const rows = await basePrisma.$queryRaw<Array<{ id: string }>>`
      SELECT l."id"
      FROM "Lead" l
      WHERE l."deletedAt" IS NULL AND l."tenantId" = ${scope.tenantId}
    `;
    return rows.map((row) => row.id);
  }
  if (!permissions.has("leads.view_owned")) return [];

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
  const scope = await actingListScope();
  if (!scope) return [];

  if (permissions === null || permissions.has("contacts.view_all")) {
    const rows = await basePrisma.contact.findMany({
      // `tenantId: scope.tenantId` rather than `...scope`: actingListScope has
      // already narrowed this to a real workspace, so the two are identical at
      // runtime — but a spread hides the predicate from the tenant-access sweep,
      // which reads the call site and cannot see through it. Naming it is what
      // the sweep asks for, and it is the honest form here anyway.
      where: { deletedAt: null, tenantId: scope.tenantId },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }
  if (!permissions.has("contacts.view_owned")) return [];

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

export async function canAccessContact(user: PermissionUser, contactId: string): Promise<boolean> {
  const contact = await basePrisma.contact.findFirst({
    where: { id: contactId, ...(await actingRecordPredicate("contact access check")) },
    select: { id: true },
  });
  if (!contact) return false;
  const ids = await getAccessibleContactIds(user);
  return ids === null || ids.includes(contactId);
}

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

export async function canAccessConversation(
  user: PermissionUser,
  conversationId: string,
): Promise<boolean> {
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
  if (conversation.contactId && (contactIds === null || contactIds.includes(conversation.contactId))) return true;
  if (conversation.leadId && (leadIds === null || leadIds.includes(conversation.leadId))) return true;
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
  const scope = await actingListScope();
  if (!scope) return [];

  if (permissions === null || permissions.has("quotes.view_all")) {
    const rows = await basePrisma.quote.findMany({
      // `tenantId: scope.tenantId` rather than `...scope`: actingListScope has
      // already narrowed this to a real workspace, so the two are identical at
      // runtime — but a spread hides the predicate from the tenant-access sweep,
      // which reads the call site and cannot see through it. Naming it is what
      // the sweep asks for, and it is the honest form here anyway.
      where: { deletedAt: null, tenantId: scope.tenantId },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }
  if (!permissions.has("quotes.view_owned")) return [];

  const [leadIds, contactIds] = await Promise.all([
    getAccessibleLeadIds(user),
    getAccessibleContactIds(user),
  ]);
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
  const scope = await actingListScope();
  if (!scope) return [];

  if (permissions === null || permissions.has("vehicles.view_all")) {
    const rows = await basePrisma.vehicle.findMany({
      // `tenantId: scope.tenantId` rather than `...scope`: actingListScope has
      // already narrowed this to a real workspace, so the two are identical at
      // runtime — but a spread hides the predicate from the tenant-access sweep,
      // which reads the call site and cannot see through it. Naming it is what
      // the sweep asks for, and it is the honest form here anyway.
      where: { deletedAt: null, tenantId: scope.tenantId },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }
  if (!permissions.has("vehicles.view_owned")) return [];

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

export async function requireVehicleAccess(
  vehicleId: string,
  permission: PermissionKey = "vehicles.manage",
): Promise<PermissionUser> {
  await requireModuleEnabled("automotive");
  const user = await requirePermission(permission);
  if (!(await canAccessVehicle(user, vehicleId))) redirect("/vehicles");
  return user;
}

export async function getAccessibleJobCardIds(user: PermissionUser): Promise<string[] | null> {
  const permissions = await scopePermissions(user);
  const scope = await actingListScope();
  if (!scope) return [];

  if (permissions === null || permissions.has("jobcards.view_all")) {
    const rows = await basePrisma.jobCard.findMany({
      // `tenantId: scope.tenantId` rather than `...scope`: actingListScope has
      // already narrowed this to a real workspace, so the two are identical at
      // runtime — but a spread hides the predicate from the tenant-access sweep,
      // which reads the call site and cannot see through it. Naming it is what
      // the sweep asks for, and it is the honest form here anyway.
      where: { deletedAt: null, tenantId: scope.tenantId },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }
  if (!permissions.has("jobcards.view_owned")) return [];

  const [contactIds, vehicleIds] = await Promise.all([
    getAccessibleContactIds(user),
    getAccessibleVehicleIds(user),
  ]);
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

export async function requireJobCardAccess(
  jobCardId: string,
  permission: PermissionKey = "jobcards.manage",
): Promise<PermissionUser> {
  await requireModuleEnabled("automotive");
  const user = await requirePermission(permission);
  if (!(await canAccessJobCard(user, jobCardId))) redirect("/jobcards");
  return user;
}

export async function getAccessibleDocumentIds(user: PermissionUser): Promise<string[] | null> {
  const permissions = await scopePermissions(user);
  const scope = await actingListScope();
  if (!scope) return [];

  if (permissions === null || permissions.has("documents.view_all")) {
    const rows = await basePrisma.document.findMany({
      // `tenantId: scope.tenantId` rather than `...scope`: actingListScope has
      // already narrowed this to a real workspace, so the two are identical at
      // runtime — but a spread hides the predicate from the tenant-access sweep,
      // which reads the call site and cannot see through it. Naming it is what
      // the sweep asks for, and it is the honest form here anyway.
      where: { deletedAt: null, tenantId: scope.tenantId },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }
  if (!permissions.has("documents.view_owned")) return [];

  const [contactIds, quoteIds, vehicleIds, jobCardIds] = await Promise.all([
    getAccessibleContactIds(user),
    getAccessibleQuoteIds(user),
    getAccessibleVehicleIds(user),
    getAccessibleJobCardIds(user),
  ]);
  const rows = await basePrisma.document.findMany({
    where: {
      deletedAt: null,
      ...(await documentTenantWhere()),
      OR: [
        { uploadedById: user.id },
        ...(contactIds === null ? [{ contactId: { not: null } }] : contactIds.length ? [{ contactId: { in: contactIds } }] : []),
        ...(quoteIds === null ? [{ quoteId: { not: null } }] : quoteIds.length ? [{ quoteId: { in: quoteIds } }] : []),
        ...(vehicleIds === null ? [{ vehicleId: { not: null } }] : vehicleIds.length ? [{ vehicleId: { in: vehicleIds } }] : []),
        ...(jobCardIds === null ? [{ jobCardId: { not: null } }] : jobCardIds.length ? [{ jobCardId: { in: jobCardIds } }] : []),
      ],
    },
    select: {
      id: true,
      uploadedById: true,
      quoteId: true,
      jobCardId: true,
      vehicleId: true,
      contactId: true,
    },
  });
  const reachable = {
    quote: idReach(quoteIds),
    jobcard: idReach(jobCardIds),
    vehicle: idReach(vehicleIds),
    contact: idReach(contactIds),
  } as const;
  return rows
    .filter((row) => {
      if (row.uploadedById === user.id) return true;
      const link = governingDocumentLink(row);
      return link !== null && reachable[link.kind](link.id);
    })
    .map((row) => row.id);
}

function idReach(ids: string[] | null): (id: string) => boolean {
  if (ids === null) return () => true;
  const set = new Set(ids);
  return (id) => set.has(id);
}

function documentTenantWhere(): Promise<{ tenantId?: string | null }> {
  return actingRecordPredicate("document scope");
}

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

export async function requireDocumentAccess(
  documentId: string,
  permission: PermissionKey = "documents.manage",
): Promise<PermissionUser> {
  const user = await requirePermission(permission);
  if (!(await canAccessDocument(user, documentId))) redirect("/documents");
  return user;
}

export async function getAccessibleCaseIds(user: PermissionUser): Promise<string[] | null> {
  const permissions = await scopePermissions(user);
  const scope = await actingScopeClass();
  // AT THE TOP — same defect as getAccessibleLeadIds had. A view_OWNED caller
  // used to walk past the view_all guard into the raw SQL with `caseTenant` as
  // `Prisma.empty`, and the `assignedToId = user.id` arm then matched that
  // person's cases in EVERY workspace.
  if (scope.mode !== "tenant") return [];
  const caseTenant = Prisma.sql`AND c."tenantId" = ${scope.tenantId}`;

  if (permissions === null || permissions.has("cases.view_all")) {
    // Written out rather than interpolated via `caseTenant` — same SQL, but the
    // access sweep reads the statement and cannot see into a fragment. The
    // `WHERE TRUE` placeholder goes with it.
    const rows = await basePrisma.$queryRaw<Array<{ id: string }>>`
      SELECT c."id" FROM "CustomerCase" c WHERE c."tenantId" = ${scope.tenantId}
    `;
    return rows.map((row) => row.id);
  }
  if (!permissions.has("cases.view_owned")) return [];

  const [contactIds, vehicleIds] = await Promise.all([
    getAccessibleContactIds(user),
    getAccessibleVehicleIds(user),
  ]);
  if (contactIds === null) return null;
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
