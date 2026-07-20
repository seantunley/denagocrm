import { redirect } from "next/navigation";
import { basePrisma } from "./db";
import { requireUser } from "./auth";

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
  "cases.view_all", "cases.view_owned", "cases.reply", "cases.manage",
  "cases.assign", "cases.create",
  "campaigns.view", "campaigns.manage", "surveys.view", "surveys.manage",
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
  modules: string;
};

const RBAC_UNAVAILABLE = "__rbac_unavailable__";
const RBAC_INITIALIZED = "__rbac_initialized__";

export async function getUserPermissions(userId: string): Promise<Set<string>> {
  try {
    const rows = await basePrisma.$queryRaw<Array<{ key: string }>>`
      SELECT DISTINCT rp."permissionKey" AS key
      FROM "UserRole" ur
      JOIN "RolePermission" rp ON rp."roleId" = ur."roleId"
      WHERE ur."userId" = ${userId}
      UNION
      SELECT ${RBAC_INITIALIZED} AS key
      WHERE EXISTS (SELECT 1 FROM "Role" LIMIT 1)
    `;
    return new Set(rows.map((row) => row.key));
  } catch {
    return new Set([RBAC_UNAVAILABLE]);
  }
}

export async function getUserPermissionList(user: PermissionUser): Promise<string[]> {
  if (user.role === "owner") return [...PERMISSIONS];
  const permissions = await getUserPermissions(user.id);
  if (permissions.has(RBAC_UNAVAILABLE) || !permissions.has(RBAC_INITIALIZED)) return [];
  return [...permissions].filter((key) => !key.startsWith("__"));
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

export async function getUserTeamIds(userId: string): Promise<string[]> {
  try {
    const rows = await basePrisma.$queryRaw<Array<{ teamId: string }>>`
      SELECT DISTINCT scope."teamId"
      FROM (
        SELECT tm."teamId" FROM "TeamMember" tm WHERE tm."userId" = ${userId}
        UNION
        SELECT t."id" AS "teamId" FROM "Team" t
        WHERE t."managerId" = ${userId} AND t."active" = true AND t."deletedAt" IS NULL
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

/* Leads use raw SQL because teamId was introduced through an additive migration
 * and intentionally is not part of the legacy Prisma Lead model. */
export async function getAccessibleLeadIds(user: PermissionUser): Promise<string[] | null> {
  const permissions = await scopePermissions(user);
  if (permissions === null || permissions.has("leads.view_all")) return null;
  if (!permissions.has("leads.view_owned")) return [];
  const rows = await basePrisma.$queryRaw<Array<{ id: string }>>`
    SELECT l."id"
    FROM "Lead" l
    WHERE l."deletedAt" IS NULL
      AND (
        l."assignedToId" = ${user.id}
        OR l."createdById" = ${user.id}
        OR l."teamId" IN (
          SELECT tm."teamId" FROM "TeamMember" tm WHERE tm."userId" = ${user.id}
          UNION
          SELECT t."id" FROM "Team" t WHERE t."managerId" = ${user.id} AND t."deletedAt" IS NULL
        )
      )
  `;
  return rows.map((row) => row.id);
}

export async function canAccessLead(user: PermissionUser, leadId: string): Promise<boolean> {
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
  const leadIds = await getAccessibleLeadIds(user);
  const rows = await basePrisma.contact.findMany({
    where: {
      deletedAt: null,
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
  const [leadIds, contactIds] = await Promise.all([getAccessibleLeadIds(user), getAccessibleContactIds(user)]);
  const rows = await basePrisma.quote.findMany({
    where: {
      deletedAt: null,
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
  const contactIds = await getAccessibleContactIds(user);
  if (contactIds === null) return null;
  const rows = await basePrisma.vehicle.findMany({
    where: {
      deletedAt: null,
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
  const ids = await getAccessibleVehicleIds(user);
  return ids === null || ids.includes(vehicleId);
}

export async function requireVehicleReadAccess(vehicleId: string): Promise<PermissionUser> {
  const user = await requireAnyPermission("vehicles.view_all", "vehicles.view_owned");
  if (!(await canAccessVehicle(user, vehicleId))) redirect("/vehicles");
  return user;
}

export async function requireVehicleAccess(vehicleId: string, permission: PermissionKey = "vehicles.manage"): Promise<PermissionUser> {
  const user = await requirePermission(permission);
  if (!(await canAccessVehicle(user, vehicleId))) redirect("/vehicles");
  return user;
}

export async function getAccessibleJobCardIds(user: PermissionUser): Promise<string[] | null> {
  const permissions = await scopePermissions(user);
  if (permissions === null || permissions.has("jobcards.view_all")) return null;
  if (!permissions.has("jobcards.view_owned")) return [];
  const [contactIds, vehicleIds] = await Promise.all([getAccessibleContactIds(user), getAccessibleVehicleIds(user)]);
  if (contactIds === null || vehicleIds === null) return null;
  const rows = await basePrisma.jobCard.findMany({
    where: {
      deletedAt: null,
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
  const ids = await getAccessibleJobCardIds(user);
  return ids === null || ids.includes(jobCardId);
}

export async function requireJobCardReadAccess(jobCardId: string): Promise<PermissionUser> {
  const user = await requireAnyPermission("jobcards.view_all", "jobcards.view_owned");
  if (!(await canAccessJobCard(user, jobCardId))) redirect("/jobcards");
  return user;
}

export async function requireJobCardAccess(jobCardId: string, permission: PermissionKey = "jobcards.manage"): Promise<PermissionUser> {
  const user = await requirePermission(permission);
  if (!(await canAccessJobCard(user, jobCardId))) redirect("/jobcards");
  return user;
}

export async function getAccessibleDocumentIds(user: PermissionUser): Promise<string[] | null> {
  const permissions = await scopePermissions(user);
  if (permissions === null || permissions.has("documents.view_all")) return null;
  if (!permissions.has("documents.view_owned")) return [];
  const [contactIds, quoteIds, vehicleIds, jobCardIds] = await Promise.all([
    getAccessibleContactIds(user), getAccessibleQuoteIds(user), getAccessibleVehicleIds(user), getAccessibleJobCardIds(user),
  ]);
  const rows = await basePrisma.document.findMany({
    where: {
      deletedAt: null,
      OR: [
        { uploadedById: user.id },
        ...(contactIds === null ? [{ contactId: { not: null } }] : contactIds.length ? [{ contactId: { in: contactIds } }] : []),
        ...(quoteIds === null ? [{ quoteId: { not: null } }] : quoteIds.length ? [{ quoteId: { in: quoteIds } }] : []),
        ...(vehicleIds === null ? [{ vehicleId: { not: null } }] : vehicleIds.length ? [{ vehicleId: { in: vehicleIds } }] : []),
        ...(jobCardIds === null ? [{ jobCardId: { not: null } }] : jobCardIds.length ? [{ jobCardId: { in: jobCardIds } }] : []),
      ],
    },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

export async function canAccessDocument(user: PermissionUser, documentId: string): Promise<boolean> {
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
  const [contactIds, vehicleIds] = await Promise.all([getAccessibleContactIds(user), getAccessibleVehicleIds(user)]);
  if (contactIds === null) return null;
  // vehicleIds === null means the user can see ALL vehicles, so every vehicle-linked
  // case is accessible — not `= ANY([])`, which would drop them all.
  // A ticket is "owned" if it belongs to an accessible contact/vehicle OR is
  // assigned to this agent (so an agent always sees their own queue).
  const rows = vehicleIds === null
    ? await basePrisma.$queryRaw<Array<{ id: string }>>`
        SELECT c."id" FROM "CustomerCase" c
        WHERE c."contactId" = ANY(${contactIds}::text[]) OR c."vehicleId" IS NOT NULL
           OR c."assignedToId" = ${user.id}`
    : await basePrisma.$queryRaw<Array<{ id: string }>>`
        SELECT c."id" FROM "CustomerCase" c
        WHERE c."contactId" = ANY(${contactIds}::text[])
           OR (c."vehicleId" IS NOT NULL AND c."vehicleId" = ANY(${vehicleIds}::text[]))
           OR c."assignedToId" = ${user.id}`;
  return rows.map((row) => row.id);
}

export async function canAccessCase(user: PermissionUser, caseId: string): Promise<boolean> {
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
