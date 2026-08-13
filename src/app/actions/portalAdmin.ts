"use server";
import { withActingStaffScope } from "@/lib/actingScope";

import { asActionResult, ActionRefusal, refuse } from "@/lib/actionResult";
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { basePrisma, prisma } from "@/lib/db";
import { getActiveTenantId } from "@/lib/auth";
import { tenantEnforcing } from "@/lib/tenantEnforcement";
import { requirePermission } from "@/lib/permissions";
import { activeTenantPredicate } from "@/lib/tenantPredicate";
import { GOVERNANCE_TX, logAudit } from "@/lib/audit";

const text = (formData: FormData, key: string) => String(formData.get(key) ?? "").trim();

/**
 * Bound with {@link withActingStaffScope} because this action reads the tenant scope
 * SYNCHRONOUSLY (inheritedTenantId / activeTenantPredicate / writeTenantId), and a
 * sync reader cannot recover a missing scope the way an awaited one can.
 *
 * A Server Action has no React request store, so #513's holder is never filled, and
 * `enterWith` inside the auth chokepoint does not reach the frame that called it —
 * the action body therefore runs with no ambient scope and the sync reader throws.
 * Binding an ENCLOSING frame here is the only shape that reaches it.
 */
export async function grantPortalAccess(formData: FormData) {
  return withActingStaffScope(async () => {
  return asActionResult(async () => {
    const user = await requirePermission("portal_access.manage");
    const viewerContactId = text(formData, "viewerContactId");
    const targetType = text(formData, "targetType");
    const targetId = text(formData, "targetId");
    const role = text(formData, "role") || "viewer";
    if (!viewerContactId || !targetId || !["contact", "fleet"].includes(targetType)) {
      throw new ActionRefusal("Viewer and target are required");
    }
    if (!["viewer", "manager", "owner"].includes(role)) throw new ActionRefusal("Invalid portal role");

    // BOTH ids come off the form and both went straight into the INSERT. Nothing
    // checked that either one names a real record, let alone one belonging to this
    // workspace — so a forged POST (every "use server" export is a public endpoint)
    // could file a grant pointing at another tenant's contact or fleet, stamped
    // with the CALLER's tenantId. Read back through the tenant filter this table
    // is being prepared for, that row is a valid grant over a foreign customer.
    //
    // Resolved here, not merely trusted. `prisma` is the scoped client, and the
    // predicate is ALSO written by hand because this file's writes go through
    // basePrisma and the guard extension is dormant today — activeTenantPredicate
    // is `{}` until enforcement is on, so today this is the existence check the
    // action has always needed, and it becomes the tenant check when RLS lands.
    //
    // Deliberately NOT canAccessContact: `portal_access.manage` is the boundary
    // the product expresses for this surface, and /settings/portal-access already
    // offers its holder every customer to pick from. Requiring contacts.view_* on
    // top would silently disable portal administration for a role that is supposed
    // to have it. Narrowing WHO may administer the portal is a product decision,
    // not a fix; this closes the id-forgery hole without making it.
    //
    // Same refusal for "not yours" and "does not exist" — a distinguishable
    // message makes this an id oracle over the customer base.
    const tenantWhere = activeTenantPredicate("portal access grant");
    const [viewer, target] = await Promise.all([
      prisma.contact.findFirst({
        where: { id: viewerContactId, deletedAt: null, ...tenantWhere },
        select: { id: true },
      }),
      targetType === "contact"
        ? prisma.contact.findFirst({
            where: { id: targetId, deletedAt: null, ...tenantWhere },
            select: { id: true },
          })
        : prisma.fleet.findFirst({
            where: { id: targetId, deletedAt: null, ...tenantWhere },
            select: { id: true },
          }),
    ]);
    if (!viewer || !target) throw new ActionRefusal("That customer isn't available.");

    const id = crypto.randomUUID();
    // Multi-tenancy readiness: stamp the owning tenant, same idiom as
    // accessControl.ts's createTeam (staff-side action, getActiveTenantId()).
    // Purely additive — nothing currently filters PortalAccessGrant by tenantId.
    const activeTenantId = await getActiveTenantId();
    if (targetType === "contact") {
      await basePrisma.$executeRaw`
        INSERT INTO "PortalAccessGrant" ("id", "tenantId", "viewerContactId", "grantedContactId", "role", "createdById")
        VALUES (${id}, ${activeTenantId}, ${viewerContactId}, ${targetId}, ${role}, ${user.id})
        ON CONFLICT ("viewerContactId", "grantedContactId") WHERE "grantedContactId" IS NOT NULL
        DO UPDATE SET "active" = true, "role" = EXCLUDED."role", "createdById" = EXCLUDED."createdById"
      `;
    } else {
      await basePrisma.$executeRaw`
        INSERT INTO "PortalAccessGrant" ("id", "tenantId", "viewerContactId", "fleetId", "role", "createdById")
        VALUES (${id}, ${activeTenantId}, ${viewerContactId}, ${targetId}, ${role}, ${user.id})
        ON CONFLICT ("viewerContactId", "fleetId") WHERE "fleetId" IS NOT NULL
        DO UPDATE SET "active" = true, "role" = EXCLUDED."role", "createdById" = EXCLUDED."createdById"
      `;
    }
    await logAudit({
      action: "portal.access_granted",
      summary: `Granted ${role} portal access to ${targetType} ${targetId}`,
      contactId: viewerContactId,
      user,
      entityType: "PortalAccessGrant",
      entityId: id,
    });
    revalidatePath("/settings/portal-access");
  });
  });
}

export async function revokePortalAccess(id: string, formData: FormData) {
  return asActionResult(async () => {
    void formData;
    const user = await requirePermission("portal_access.manage");
    const rows = await basePrisma.$queryRaw<Array<{ viewerContactId: string; tenantId: string | null }>>`
      SELECT "viewerContactId", "tenantId" FROM "PortalAccessGrant" WHERE "id" = ${id} LIMIT 1
    `;
    const grant = rows[0];
    if (!grant) throw new ActionRefusal("Portal access grant not found");
    // Multi-tenancy readiness: confirm the grant belongs to the caller's tenant
    // before flipping it off. Gated on tenantEnforcing() — PortalAccessGrant rows
    // written before this change may still be NULL-tenant, so comparing
    // unconditionally against a real activeTenantId could wrongly 404 a legitimate
    // revoke today; this keeps today's behaviour unchanged and only asserts the
    // boundary once enforcement (and the tenant stamping it depends on) is on.
    if (tenantEnforcing()) {
      const activeTenantId = await getActiveTenantId();
      if (grant.tenantId !== activeTenantId) throw new ActionRefusal("Portal access grant not found");
    }
    await basePrisma.$executeRaw`UPDATE "PortalAccessGrant" SET "active" = false WHERE "id" = ${id}`;
    await logAudit({
      action: "portal.access_revoked",
      summary: "Revoked portal access grant",
      contactId: grant.viewerContactId,
      user,
      entityType: "PortalAccessGrant",
      entityId: id,
    });
    revalidatePath("/settings/portal-access");
  });
}

type ProfileRequestRow = {
  id: string;
  contactId: string;
  changes: Record<string, unknown>;
  status: string;
};

function optionalText(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") return value.slice(0, 500);
  return undefined;
}

function profileData(changes: Record<string, unknown>): Prisma.ContactUpdateInput {
  const data: Prisma.ContactUpdateInput = {};
  if (changes.firstName !== undefined) {
    if (typeof changes.firstName !== "string" || !changes.firstName.trim()) {
      throw new Error("First name cannot be blank");
    }
    data.firstName = changes.firstName.slice(0, 200);
  }
  const lastName = optionalText(changes.lastName);
  const phone = optionalText(changes.phone);
  const whatsapp = optionalText(changes.whatsapp);
  const address = optionalText(changes.address);
  const suburb = optionalText(changes.suburb);
  const city = optionalText(changes.city);
  const province = optionalText(changes.province);
  const postalCode = optionalText(changes.postalCode);
  if (lastName !== undefined) data.lastName = lastName;
  if (phone !== undefined) data.phone = phone;
  if (whatsapp !== undefined) data.whatsapp = whatsapp;
  if (address !== undefined) data.address = address;
  if (suburb !== undefined) data.suburb = suburb;
  if (city !== undefined) data.city = city;
  if (province !== undefined) data.province = province;
  if (postalCode !== undefined) data.postalCode = postalCode;
  return data;
}

export async function reviewPortalProfileRequest(
  id: string,
  decision: "approved" | "rejected",
  formData: FormData
) {
  return asActionResult(async () => {
    const user = await requirePermission("portal_access.manage");
    const reviewNote = text(formData, "reviewNote") || null;
    const rows = await basePrisma.$queryRaw<ProfileRequestRow[]>`
      SELECT "id", "contactId", "changes", "status"
      FROM "PortalProfileChangeRequest" WHERE "id" = ${id} LIMIT 1
    `;
    const request = rows[0];
    if (!request) throw new ActionRefusal("Profile request not found");
    if (request.status !== "pending") throw new ActionRefusal("Profile request has already been reviewed");

    const before = await prisma.contact.findUniqueOrThrow({ where: { id: request.contactId } });
    const changes = profileData(request.changes);
    await basePrisma.$transaction(async (tx) => {
      // Lock the request and RE-CHECK inside the transaction. The check above
      // happens outside it, so two reviewers could both pass it: the second's
      // conditional UPDATE then matched zero rows — which was never inspected —
      // while the contact changes were still applied and a contradictory
      // notification sent, and both reviewers were told it worked.
      const locked = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT "status" FROM "PortalProfileChangeRequest" WHERE "id" = ${id} FOR UPDATE
      `;
      if (!locked[0]) refuse("Profile request not found.");
      if (locked[0].status !== "pending") {
        refuse("Someone else reviewed this request already. Refresh to see the outcome.");
      }
      if (decision === "approved") {
        await tx.contact.update({ where: { id: request.contactId }, data: changes });
      }
      const reviewed = await tx.$executeRaw`
        UPDATE "PortalProfileChangeRequest"
        SET "status" = ${decision}, "reviewNote" = ${reviewNote}, "reviewedAt" = CURRENT_TIMESTAMP, "reviewedById" = ${user.id}
        WHERE "id" = ${id} AND "status" = 'pending'
      `;
      if (reviewed !== 1) refuse("Someone else reviewed this request already. Refresh to see the outcome.");
      await tx.$executeRaw`
        INSERT INTO "PortalNotification" ("id", "contactId", "title", "body", "href", "kind")
        VALUES (
          ${crypto.randomUUID()}, ${request.contactId},
          ${decision === "approved" ? "Profile update approved" : "Profile update needs attention"},
          ${decision === "approved" ? "Your requested profile changes have been applied." : reviewNote || "Your requested profile changes were not applied."},
          '/portal/profile', 'profile'
        )
      `;
    }, GOVERNANCE_TX);
    await logAudit({
      action: `portal.profile_change_${decision}`,
      summary: `Portal profile request ${decision}`,
      contactId: request.contactId,
      user,
      entityType: "PortalProfileChangeRequest",
      entityId: id,
      before,
      after: decision === "approved" ? changes : { decision, reviewNote },
    });
    revalidatePath("/settings/portal-access");
    revalidatePath(`/contacts/${request.contactId}`);
  });
}
