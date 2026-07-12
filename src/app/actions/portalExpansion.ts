"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { basePrisma, prisma } from "@/lib/db";
import { getPortalContact } from "@/lib/portal";
import {
  portalCanAccessCase,
  portalCanAccessContact,
  portalCanAccessVehicle,
  requirePortalScope,
} from "@/lib/portalAccess";
import { saveFile } from "@/lib/storage";
import { logAudit } from "@/lib/audit";
import { sendPushToAll } from "@/lib/push";
import { contactName } from "@/lib/format";

export type PortalActionState = { ok?: string; error?: string };
const text = (value: FormDataEntryValue | null) => String(value ?? "").trim();
const MAX_UPLOAD = 10 * 1024 * 1024;
const ALLOWED_UPLOAD_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

async function portalUser() {
  const contact = await getPortalContact();
  if (!contact) throw new Error("Please sign in again.");
  return contact;
}

export async function submitProfileChange(
  _previous: PortalActionState | undefined,
  formData: FormData
): Promise<PortalActionState> {
  try {
    const contact = await portalUser();
    const changes = {
      firstName: text(formData.get("firstName")),
      lastName: text(formData.get("lastName")) || null,
      phone: text(formData.get("phone")) || null,
      whatsapp: text(formData.get("whatsapp")) || null,
      address: text(formData.get("address")) || null,
      suburb: text(formData.get("suburb")) || null,
      city: text(formData.get("city")) || null,
      province: text(formData.get("province")) || null,
      postalCode: text(formData.get("postalCode")) || null,
    };
    if (!changes.firstName) return { error: "First name is required." };

    await basePrisma.$executeRaw`
      INSERT INTO "PortalProfileChangeRequest" ("id", "contactId", "changes", "note")
      VALUES (${crypto.randomUUID()}, ${contact.id}, ${JSON.stringify(changes)}::jsonb, ${text(formData.get("note")) || null})
    `;
    await logAudit({
      action: "portal.profile_change_requested",
      summary: `Profile change requested by ${contactName(contact)}`,
      contactId: contact.id,
      userName: "Customer portal",
    });
    await sendPushToAll({
      title: "Portal profile update",
      body: `${contactName(contact)} requested profile changes`,
      url: `/contacts/${contact.id}`,
    }, "portal_profile").catch(() => {});
    revalidatePath("/portal/profile");
    return { ok: "Your requested changes were submitted for review." };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not submit the request." };
  }
}

export async function updatePortalPreferences(
  _previous: PortalActionState | undefined,
  formData: FormData
): Promise<PortalActionState> {
  try {
    const contact = await portalUser();
    const serviceReminders = formData.get("serviceReminders") === "on";
    const portalNotifications = formData.get("portalNotifications") === "on";
    const marketingEmail = formData.get("marketingEmail") === "on";
    const smsServiceUpdates = formData.get("smsServiceUpdates") === "on";

    await basePrisma.$executeRaw`
      INSERT INTO "PortalPreference" (
        "contactId", "serviceReminders", "portalNotifications", "marketingEmail",
        "emailServiceUpdates", "smsServiceUpdates", "emailMarketing", "updatedAt"
      ) VALUES (
        ${contact.id}, ${serviceReminders}, ${portalNotifications}, ${marketingEmail},
        ${serviceReminders}, ${smsServiceUpdates}, ${marketingEmail}, CURRENT_TIMESTAMP
      )
      ON CONFLICT ("contactId") DO UPDATE SET
        "serviceReminders" = EXCLUDED."serviceReminders",
        "portalNotifications" = EXCLUDED."portalNotifications",
        "marketingEmail" = EXCLUDED."marketingEmail",
        "emailServiceUpdates" = EXCLUDED."emailServiceUpdates",
        "smsServiceUpdates" = EXCLUDED."smsServiceUpdates",
        "emailMarketing" = EXCLUDED."emailMarketing",
        "updatedAt" = CURRENT_TIMESTAMP
    `;

    if (contact.marketingOptOut === marketingEmail) {
      await prisma.contact.update({
        where: { id: contact.id },
        data: { marketingOptOut: !marketingEmail },
      });
      await prisma.consentRecord.create({
        data: {
          type: "marketing",
          granted: marketingEmail,
          source: "portal",
          note: marketingEmail ? "Customer opted in through portal" : "Customer opted out through portal",
          contactId: contact.id,
        },
      });
    }

    await logAudit({
      action: "portal.preferences_updated",
      summary: `Portal communication preferences updated by ${contactName(contact)}`,
      contactId: contact.id,
      userName: "Customer portal",
    });
    revalidatePath("/portal/profile");
    return { ok: "Preferences saved." };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not save preferences." };
  }
}

export async function createPortalCase(
  _previous: PortalActionState | undefined,
  formData: FormData
): Promise<PortalActionState> {
  try {
    const contact = await portalUser();
    const subject = text(formData.get("subject"));
    const description = text(formData.get("description"));
    const type = text(formData.get("type")) || "support";
    const priority = text(formData.get("priority")) || "normal";
    const vehicleId = text(formData.get("vehicleId")) || null;
    const forContactId = text(formData.get("contactId")) || contact.id;

    if (subject.length < 3 || description.length < 10) {
      return { error: "Add a subject and a little more detail." };
    }
    if (!(await portalCanAccessContact(forContactId))) return { error: "That customer is not available in your portal." };
    if (vehicleId && !(await portalCanAccessVehicle(vehicleId))) return { error: "That vehicle is not available in your portal." };

    const id = crypto.randomUUID();
    const users = await prisma.user.findMany({ orderBy: { createdAt: "asc" }, take: 1 });
    await basePrisma.$executeRaw`
      INSERT INTO "CustomerCase" (
        "id", "subject", "description", "type", "priority", "source", "contactId", "vehicleId", "assignedToId"
      ) VALUES (
        ${id}, ${subject}, ${description}, ${type}, ${priority}, 'portal', ${forContactId}, ${vehicleId}, ${users[0]?.id ?? null}
      )
    `;
    await basePrisma.$executeRaw`
      INSERT INTO "CustomerCaseMessage" ("id", "caseId", "contactId", "direction", "body")
      VALUES (${crypto.randomUUID()}, ${id}, ${contact.id}, 'customer', ${description})
    `;
    const rows = await basePrisma.$queryRaw<Array<{ number: bigint }>>`
      SELECT "number" FROM "CustomerCase" WHERE "id" = ${id}
    `;
    const number = rows[0]?.number?.toString() ?? "new";
    await logAudit({
      action: "portal.case_created",
      summary: `Portal case C-${number} created: ${subject}`,
      contactId: forContactId,
      userName: "Customer portal",
    });
    await sendPushToAll({
      title: type === "warranty" ? "New warranty request" : "New portal support case",
      body: `C-${number} · ${subject}`,
      url: `/contacts/${forContactId}`,
    }, "portal_case").catch(() => {});
    revalidatePath("/portal/support");
    return { ok: `Case C-${number} was submitted.` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not create the case." };
  }
}

export async function addPortalCaseMessage(
  caseId: string,
  _previous: PortalActionState | undefined,
  formData: FormData
): Promise<PortalActionState> {
  try {
    const contact = await portalUser();
    if (!(await portalCanAccessCase(caseId))) return { error: "Case not found." };
    const body = text(formData.get("body"));
    if (body.length < 2) return { error: "Enter a message." };
    await basePrisma.$transaction([
      basePrisma.$executeRaw`
        INSERT INTO "CustomerCaseMessage" ("id", "caseId", "contactId", "direction", "body")
        VALUES (${crypto.randomUUID()}, ${caseId}, ${contact.id}, 'customer', ${body})
      `,
      basePrisma.$executeRaw`
        UPDATE "CustomerCase" SET "status" = CASE WHEN "status" IN ('resolved', 'closed') THEN 'open' ELSE "status" END,
          "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${caseId}
      `,
    ]);
    revalidatePath(`/portal/support/${caseId}`);
    return { ok: "Message sent." };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not send the message." };
  }
}

export async function uploadPortalFile(
  _previous: PortalActionState | undefined,
  formData: FormData
): Promise<PortalActionState> {
  try {
    const contact = await portalUser();
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { error: "Choose a file." };
    if (file.size > MAX_UPLOAD) return { error: "Files must be 10 MB or smaller." };
    if (!ALLOWED_UPLOAD_TYPES.has(file.type)) return { error: "Upload a PDF, JPG, PNG or WebP file." };
    const vehicleId = text(formData.get("vehicleId")) || null;
    const caseId = text(formData.get("caseId")) || null;
    if (vehicleId && !(await portalCanAccessVehicle(vehicleId))) return { error: "Vehicle not found." };
    if (caseId && !(await portalCanAccessCase(caseId))) return { error: "Case not found." };

    const buffer = Buffer.from(await file.arrayBuffer());
    const storedName = await saveFile(buffer, file.name, file.type);
    await basePrisma.$executeRaw`
      INSERT INTO "PortalUpload" (
        "id", "contactId", "caseId", "vehicleId", "fileName", "storedName", "mimeType", "sizeBytes"
      ) VALUES (
        ${crypto.randomUUID()}, ${contact.id}, ${caseId}, ${vehicleId}, ${file.name}, ${storedName}, ${file.type}, ${file.size}
      )
    `;
    await logAudit({
      action: "portal.file_uploaded",
      summary: `${file.name} uploaded through the customer portal`,
      contactId: contact.id,
      userName: "Customer portal",
    });
    revalidatePath("/portal/documents");
    if (caseId) revalidatePath(`/portal/support/${caseId}`);
    return { ok: "File uploaded securely." };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not upload the file." };
  }
}

export async function markPortalNotificationRead(id: string) {
  const scope = await requirePortalScope();
  await basePrisma.$executeRaw`
    UPDATE "PortalNotification" SET "readAt" = COALESCE("readAt", CURRENT_TIMESTAMP)
    WHERE "id" = ${id} AND "contactId" = ${scope.viewerContactId}
  `;
  revalidatePath("/portal");
}
