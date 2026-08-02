import { redirect } from "next/navigation";
import { basePrisma } from "./db";
import { requireUser } from "./auth";
import { requireModuleEnabled } from "./modules/enabled";
import { activeTenantPredicate } from "./tenantPredicate";
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
  return requireAnyPermission(...rule.anyOf);
}

/** Every guarded prefix, for tests and tooling that inventory the surface. */
export const GUARDED_ROUTES = ROUTE_RULES.map((rule) => rule.prefix);

/**
 * "May work with customer records at all" — the RBAC replacement for the legacy
 * crm/workshop module flags on actions that touch a contact or a lead without
 * being scoped to one entity type (notes, emails, AI helpers). Spread it into
 * `requireAnyPermission`; the record-level `canAccessContact`/`canAccessLead`
 * checks at each call site still decide WHICH records.
 */
export const CUSTOMER_RECORD_PERMISSIONS = [
  "contacts.view_all",
  "contacts.view_owned",
  "leads.view_all",
  "leads.view_owned",
] as const satisfies readonly PermissionKey[];

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
  // Job cards are automotive-owned; same central-gate reasoning as
  // requireVehicleAccess — every job-card edit and job-card-targeted document
  // action funnels through here, so the pack is enforced once. Throws when off.
  await requireModuleEnabled("automotive");
  const user = await requirePermission(permission);
  if (!(await canAccessJobCard(user, jobCardId))) redirect("/jobcards");
  return user;
}

/**
 * Document scope is a union of accessible linked records plus files uploaded by
 * the user. An unrestricted contact/quote/vehicle scope grants all documents
 * linked to that record type, but never unrelated unfiled documents.
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
      ...documentTenantWhere(),
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

/**
 * The active tenant, as an explicit predicate for a basePrisma document query.
 *
 * NO SCOPE and a scope whose tenantId is null are different facts. Collapsing
 * them with `?? null` filters on the legacy untenanted value, and since
 * establishStaffTenantScope enters no scope at all unless
 * TENANT_ENFORCEMENT=enforce — while off/monitor are the documented default and
 * rollback modes — every migrated document would have stopped matching.
 */
function documentTenantWhere(): { tenantId?: string | null } {
  return activeTenantPredicate("document scope");
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
    where: { id: documentId, ...documentTenantWhere() },
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
