import { basePrisma } from "./db";
import { soleActiveTenant } from "./tenant";

export type LeadToContactErrorCode =
  | "tenant_unavailable"
  | "lead_unavailable"
  | "matching_contact_unavailable"
  | "ambiguous_contact_match"
  | "concurrent_change";

export class LeadToContactError extends Error {
  constructor(
    public readonly code: LeadToContactErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LeadToContactError";
  }
}

export type LeadToContactResult = {
  lead: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    source: string;
    contactId: string | null;
  };
  contactId: string;
  created: boolean;
  alreadyLinked: boolean;
};

/**
 * Convert an existing lead into a linked contact without crossing tenant or RBAC
 * boundaries. The active membership and lead row are locked in the same database
 * transaction so two submissions for the same lead cannot both create contacts.
 */
export async function addLeadToContactsAtomic({
  leadId,
  userId,
  accessibleContactIds,
}: {
  leadId: string;
  userId: string;
  accessibleContactIds: string[] | null;
}): Promise<LeadToContactResult> {
  const accessible = accessibleContactIds === null ? null : new Set(accessibleContactIds);

  return basePrisma.$transaction(async (tx) => {
    // Stabilise the acting tenant for this write. Shared locks allow unrelated
    // conversions to proceed concurrently while tenant suspension/membership
    // deletion waits until this transaction finishes.
    const memberships = await tx.$queryRaw<{ tenantId: string }[]>`
      SELECT m."tenantId" AS "tenantId"
      FROM "TenantMember" m
      JOIN "Tenant" t ON t."id" = m."tenantId"
      WHERE m."userId" = ${userId} AND t."active" = true
      FOR SHARE OF t, m`;
    const actingTenant = soleActiveTenant(memberships.map((row) => row.tenantId));
    if ("error" in actingTenant) {
      throw new LeadToContactError(
        "tenant_unavailable",
        "Your active workspace could not be resolved. Refresh and try again.",
      );
    }
    const tenantId = actingTenant.tenantId;

    // Lock the precise live lead in the active tenant before checking contactId.
    // A concurrent submission waits here, then observes the first link and exits.
    const lockedLead = await tx.$queryRaw<{ id: string }[]>`
      SELECT l."id"
      FROM "Lead" l
      WHERE l."id" = ${leadId}
        AND l."tenantId" = ${tenantId}
        AND l."deletedAt" IS NULL
      FOR UPDATE`;
    if (lockedLead.length !== 1) {
      throw new LeadToContactError(
        "lead_unavailable",
        "That lead is not available in your current workspace.",
      );
    }

    const lead = await tx.lead.findFirstOrThrow({
      where: { id: leadId, tenantId, deletedAt: null },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        source: true,
        notes: true,
        assignedToId: true,
        contactId: true,
      },
    });
    if (lead.contactId) {
      return {
        lead,
        contactId: lead.contactId,
        created: false,
        alreadyLinked: true,
      };
    }

    const email = lead.email?.trim() || null;
    const phone = lead.phone?.trim() || null;
    const matchers = [
      ...(email ? [{ email: { equals: email, mode: "insensitive" as const } }] : []),
      ...(phone ? [{ phone }] : []),
    ];
    const matches = matchers.length
      ? await tx.contact.findMany({
          where: { tenantId, deletedAt: null, OR: matchers },
          orderBy: { createdAt: "asc" },
          take: 2,
          select: { id: true },
        })
      : [];

    if (matches.length > 1) {
      throw new LeadToContactError(
        "ambiguous_contact_match",
        "More than one matching contact exists. Link the correct customer manually.",
      );
    }

    let contactId: string;
    let created = false;
    if (matches.length === 1) {
      contactId = matches[0].id;
      if (accessible !== null && !accessible.has(contactId)) {
        throw new LeadToContactError(
          "matching_contact_unavailable",
          "A matching customer record exists but is not available to you. Ask an administrator to link it.",
        );
      }
    } else {
      let ownerId = userId;
      if (lead.assignedToId) {
        const ownerMembership = await tx.tenantMember.findFirst({
          where: {
            tenantId,
            userId: lead.assignedToId,
            tenant: { active: true },
          },
          select: { userId: true },
        });
        if (ownerMembership) ownerId = ownerMembership.userId;
      }

      const [firstName, ...rest] = lead.name.trim().split(/\s+/);
      const contact = await tx.contact.create({
        data: {
          tenantId,
          firstName: firstName || lead.name,
          lastName: rest.join(" ") || null,
          email,
          phone,
          source: lead.source,
          notes: lead.notes,
          createdById: userId,
          ownerId,
        },
        select: { id: true },
      });
      contactId = contact.id;
      created = true;
    }

    // The row lock makes this conditional claim deterministic; the predicate is
    // retained as defence in depth and rolls back a newly-created contact if some
    // future code path changes the lead without taking the same lock.
    const linked = await tx.lead.updateMany({
      where: {
        id: leadId,
        tenantId,
        deletedAt: null,
        contactId: null,
      },
      data: { contactId },
    });
    if (linked.count !== 1) {
      throw new LeadToContactError(
        "concurrent_change",
        "The lead changed while it was being linked. Refresh and try again.",
      );
    }

    return {
      lead: { ...lead, contactId },
      contactId,
      created,
      alreadyLinked: false,
    };
  });
}
