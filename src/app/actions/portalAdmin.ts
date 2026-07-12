"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { basePrisma, prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

const text = (formData: FormData, key: string) => String(formData.get(key) ?? "").trim();

export async function grantPortalAccess(formData: FormData) {
  const user = await requireOwner();
  const viewerContactId = text(formData, "viewerContactId");
  const targetType = text(formData, "targetType");
  const targetId = text(formData, "targetId");
  const role = text(formData, "role") || "viewer";
  if (!viewerContactId || !targetId || !["contact", "fleet"].includes(targetType)) {
    throw new Error("Viewer and target are required");
  }
  if (!["viewer", "manager", "owner"].includes(role)) throw new Error("Invalid portal role");

  const id = crypto.randomUUID();
  if (targetType === "contact") {
    await basePrisma.$executeRaw`
      INSERT INTO "PortalAccessGrant" ("id", "viewerContactId", "grantedContactId", "role", "createdById")
      VALUES (${id}, ${viewerContactId}, ${targetId}, ${role}, ${user.id})
      ON CONFLICT ("viewerContactId", "grantedContactId") WHERE "grantedContactId" IS NOT NULL
      DO UPDATE SET "active" = true, "role" = EXCLUDED."role", "createdById" = EXCLUDED."createdById"
    `;
  } else {
    await basePrisma.$executeRaw`
      INSERT INTO "PortalAccessGrant" ("id", "viewerContactId", "fleetId", "role", "createdById")
      VALUES (${id}, ${viewerContactId}, ${targetId}, ${role}, ${user.id})
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
}

export async function revokePortalAccess(id: string, formData: FormData) {
  void formData;
  const user = await requireOwner();
  const rows = await basePrisma.$queryRaw<Array<{ viewerContactId: string }>>`
    SELECT "viewerContactId" FROM "PortalAccessGrant" WHERE "id" = ${id} LIMIT 1
  `;
  await basePrisma.$executeRaw`
    UPDATE "PortalAccessGrant" SET "active" = false WHERE "id" = ${id}
  `;
  await logAudit({
    action: "portal.access_revoked",
    summary: "Revoked portal access grant",
    contactId: rows[0]?.viewerContactId ?? null,
    user,
    entityType: "PortalAccessGrant",
    entityId: id,
  });
  revalidatePath("/settings/portal-access");
}

type ProfileRequestRow = {
  id: string;
  contactId: string;
  changes: Record<string, unknown>;
  status: string;
};

function profileData(changes: Record<string, unknown>) {
  const allowed = ["firstName", "lastName", "phone", "whatsapp", "address", "suburb", "city", "province", "postalCode"] as const;
  const data: Partial<Record<(typeof allowed)[number], string | null>> = {};
  for (const key of allowed) {
    const value = changes[key];
    if (value === null) data[key] = null;
    else if (typeof value === "string") data[key] = value.slice(0, 500);
  }
  if (data.firstName !== undefined && !data.firstName?.trim()) throw new Error("First name cannot be blank");
  return data;
}

export async function reviewPortalProfileRequest(
  id: string,
  decision: "approved" | "rejected",
  formData: FormData
) {
  const user = await requireOwner();
  const reviewNote = text(formData, "reviewNote") || null;
  const rows = await basePrisma.$queryRaw<ProfileRequestRow[]>`
    SELECT "id", "contactId", "changes", "status"
    FROM "PortalProfileChangeRequest" WHERE "id" = ${id} LIMIT 1
  `;
  const request = rows[0];
  if (!request) throw new Error("Profile request not found");
  if (request.status !== "pending") throw new Error("Profile request has already been reviewed");

  const before = await prisma.contact.findUniqueOrThrow({ where: { id: request.contactId } });
  const changes = profileData(request.changes);
  await basePrisma.$transaction(async (tx) => {
    if (decision === "approved") {
      await tx.contact.update({ where: { id: request.contactId }, data: changes });
    }
    await tx.$executeRaw`
      UPDATE "PortalProfileChangeRequest"
      SET "status" = ${decision}, "reviewNote" = ${reviewNote}, "reviewedAt" = CURRENT_TIMESTAMP, "reviewedById" = ${user.id}
      WHERE "id" = ${id} AND "status" = 'pending'
    `;
    await tx.$executeRaw`
      INSERT INTO "PortalNotification" ("id", "contactId", "title", "body", "href", "kind")
      VALUES (
        ${crypto.randomUUID()}, ${request.contactId},
        ${decision === "approved" ? "Profile update approved" : "Profile update needs attention"},
        ${decision === "approved" ? "Your requested profile changes have been applied." : reviewNote || "Your requested profile changes were not applied."},
        '/portal/profile', 'profile'
      )
    `;
  });
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
}
