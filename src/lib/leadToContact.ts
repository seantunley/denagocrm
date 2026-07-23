import "server-only";

import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";
import { resolveActingTenant } from "./tenantContext";

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
 * Create or reuse a contact for a lead inside one tenant-scoped transaction.
 * The conditional lead update is the concurrency gate: a losing simultaneous
 * request throws, which rolls back any contact it created in the transaction.
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
    const actingTenant = await resolveActingTenant(userId, tx);
    if ("error" in actingTenant) {
      throw new LeadToContactError(
        "tenant_unavailable",
        "Your active workspace could not be resolved. Refresh and try again.",
      );
    }
    const tenantId = actingTenant.tenantId;

    const lead = await tx.lead.findFirst({
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
    if (!lead) {
      throw new LeadToContactError(
        "lead_unavailable",
        "That lead is not available in your current workspace.",
      );
    }
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
    const matchers: Prisma.ContactWhereInput[] = [
      ...(email ? [{ email: { equals: email, mode: "insensitive" } }] : []),
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
        "The lead was linked by another request. Refresh and try again.",
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
