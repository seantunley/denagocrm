"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { basePrisma } from "@/lib/db";
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
