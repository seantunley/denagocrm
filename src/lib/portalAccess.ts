import { basePrisma } from "./db";
import { getPortalContact } from "./portal";
import { isModuleEnabled } from "./modules/enabled";

export type PortalScope = {
  viewerContactId: string;
  contactIds: string[];
  fleetIds: string[];
  roleByContactId: Map<string, string>;
  roleByFleetId: Map<string, string>;
};

type GrantRow = {
  grantedContactId: string | null;
  fleetId: string | null;
  role: string;
};

export async function getPortalScope(): Promise<PortalScope | null> {
  const contact = await getPortalContact();
  if (!contact) return null;

  const grants = await basePrisma.$queryRaw<GrantRow[]>`
    SELECT "grantedContactId", "fleetId", "role"
    FROM "PortalAccessGrant"
    WHERE "viewerContactId" = ${contact.id} AND "active" = true
  `;

  const contactIds = new Set<string>([contact.id]);
  const fleetIds = new Set<string>();
  const roleByContactId = new Map<string, string>([[contact.id, "owner"]]);
  const roleByFleetId = new Map<string, string>();

  for (const grant of grants) {
    if (grant.grantedContactId) {
      contactIds.add(grant.grantedContactId);
      roleByContactId.set(grant.grantedContactId, grant.role);
    }
    if (grant.fleetId) {
      fleetIds.add(grant.fleetId);
      roleByFleetId.set(grant.fleetId, grant.role);
    }
  }

  const linkedFleets = await basePrisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Fleet"
    WHERE "deletedAt" IS NULL AND "contactId" = ANY(${[...contactIds]}::text[])
  `;
  for (const fleet of linkedFleets) {
    fleetIds.add(fleet.id);
    if (!roleByFleetId.has(fleet.id)) roleByFleetId.set(fleet.id, "owner");
  }

  return {
    viewerContactId: contact.id,
    contactIds: [...contactIds],
    fleetIds: [...fleetIds],
    roleByContactId,
    roleByFleetId,
  };
}

export async function requirePortalScope(): Promise<PortalScope> {
  // Explicit module gate so every action funnelling through here (profile,
  // preferences, case create, case message, upload, notification-read) throws a
  // clear error when the portal pack is off — belt-and-braces with getPortal
  // Contact() returning null when disabled.
  if (!(await isModuleEnabled("portal"))) throw new Error("Customer portal is disabled");
  const scope = await getPortalScope();
  if (!scope) throw new Error("Portal authentication required");
  return scope;
}

export async function portalCanAccessContact(contactId: string): Promise<boolean> {
  const scope = await getPortalScope();
  return Boolean(scope?.contactIds.includes(contactId));
}

export async function portalCanAccessVehicle(vehicleId: string): Promise<boolean> {
  const scope = await getPortalScope();
  if (!scope) return false;
  const rows = await basePrisma.$queryRaw<Array<{ allowed: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM "Vehicle" v
      WHERE v."id" = ${vehicleId} AND v."deletedAt" IS NULL
        AND (
          v."contactId" = ANY(${scope.contactIds}::text[])
          OR (v."fleetId" IS NOT NULL AND v."fleetId" = ANY(${scope.fleetIds}::text[]))
        )
    ) AS "allowed"
  `;
  return Boolean(rows[0]?.allowed);
}

export async function portalCanAccessQuote(quoteId: string): Promise<boolean> {
  const scope = await getPortalScope();
  if (!scope) return false;
  const rows = await basePrisma.$queryRaw<Array<{ allowed: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM "Quote" q
      WHERE q."id" = ${quoteId} AND q."deletedAt" IS NULL
        AND q."contactId" = ANY(${scope.contactIds}::text[])
    ) AS "allowed"
  `;
  return Boolean(rows[0]?.allowed);
}

export async function portalCanAccessCase(caseId: string): Promise<boolean> {
  const scope = await getPortalScope();
  if (!scope) return false;
  const rows = await basePrisma.$queryRaw<Array<{ allowed: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM "CustomerCase" c
      LEFT JOIN "Vehicle" v ON v."id" = c."vehicleId"
      WHERE c."id" = ${caseId}
        AND (
          c."contactId" = ANY(${scope.contactIds}::text[])
          OR (v."fleetId" IS NOT NULL AND v."fleetId" = ANY(${scope.fleetIds}::text[]))
        )
    ) AS "allowed"
  `;
  return Boolean(rows[0]?.allowed);
}

export async function portalCanAccessDocument(documentId: string): Promise<boolean> {
  const scope = await getPortalScope();
  if (!scope) return false;
  const rows = await basePrisma.$queryRaw<Array<{ allowed: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM "Document" d
      LEFT JOIN "Vehicle" v ON v."id" = d."vehicleId"
      LEFT JOIN "Quote" q ON q."id" = d."quoteId"
      WHERE d."id" = ${documentId} AND d."deletedAt" IS NULL
        AND (
          d."contactId" = ANY(${scope.contactIds}::text[])
          OR v."contactId" = ANY(${scope.contactIds}::text[])
          OR (v."fleetId" IS NOT NULL AND v."fleetId" = ANY(${scope.fleetIds}::text[]))
          OR q."contactId" = ANY(${scope.contactIds}::text[])
        )
    ) AS "allowed"
  `;
  return Boolean(rows[0]?.allowed);
}
