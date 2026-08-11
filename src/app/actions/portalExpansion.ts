"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { basePrisma, prisma } from "@/lib/db";
import { getPortalContact } from "@/lib/portal";
import { portalTenantId, tenantOfCase } from "@/lib/portalTenant";
import { resolveTenantActor } from "@/lib/tenantActor";
import {
  portalCanAccessCase,
  portalCanAccessContact,
  portalCanAccessVehicle,
  requirePortalScope,
} from "@/lib/portalAccess";
import { saveFile } from "@/lib/storage";
import { isModuleEnabled } from "@/lib/modules/enabled";
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

    // Multi-tenancy readiness: portalUser() -> getPortalContact() already
    // entered the tenant scope (under enforcement); ambient read here, null
    // when not enforcing (today) — matches audit.ts's non-user branch.
    const tenantId = await portalTenantId(contact.id);
    await basePrisma.$executeRaw`
      INSERT INTO "PortalProfileChangeRequest" ("id", "tenantId", "contactId", "changes", "note")
      VALUES (${crypto.randomUUID()}, ${tenantId}, ${contact.id}, ${JSON.stringify(changes)}::jsonb, ${text(formData.get("note")) || null})
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

    const tenantId = await portalTenantId(contact.id);
    await basePrisma.$executeRaw`
      INSERT INTO "PortalPreference" (
        "contactId", "tenantId", "serviceReminders", "portalNotifications", "marketingEmail",
        "emailServiceUpdates", "smsServiceUpdates", "emailMarketing", "updatedAt"
      ) VALUES (
        ${contact.id}, ${tenantId}, ${serviceReminders}, ${portalNotifications}, ${marketingEmail},
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
    let type = text(formData.get("type")) || "support";
    const priority = text(formData.get("priority")) || "normal";
    let vehicleId = text(formData.get("vehicleId")) || null;
    const forContactId = text(formData.get("contactId")) || contact.id;

    // Automotive is optional: a stale/tampered form must not inject automotive
    // data when the pack is off. Drop any vehicle link and coerce automotive
    // request types back to generic support.
    if (!(await isModuleEnabled("automotive"))) {
      vehicleId = null;
      if (type === "service" || type === "warranty" || type === "delivery") type = "support";
    }

    if (subject.length < 3 || description.length < 10) {
      return { error: "Add a subject and a little more detail." };
    }
    if (!(await portalCanAccessContact(forContactId))) return { error: "That customer is not available in your portal." };
    if (vehicleId && !(await portalCanAccessVehicle(vehicleId))) return { error: "That vehicle is not available in your portal." };

    const id = crypto.randomUUID();
    // Tenant-aware staff picker (was prisma.user.findMany — the platform's
    // globally-first user, ignoring which tenant this portal contact belongs
    // to) — reuse the same resolver portal.ts's firstStaffUser() already wraps.
    const staff = await resolveTenantActor();
    const mailboxes = await basePrisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "SupportMailbox" WHERE "slug" = 'support' LIMIT 1
    `;
    const mailboxId = mailboxes[0]?.id ?? null;
    // Multi-tenancy readiness: ambient tenant, entered by portalUser() ->
    // getPortalContact() above (under enforcement); null when not enforcing.
    const tenantId = await portalTenantId(contact.id);
    await basePrisma.$executeRaw`
      INSERT INTO "CustomerCase" (
        "id", "tenantId", "subject", "description", "type", "priority", "source", "contactId", "vehicleId", "assignedToId",
        "mailboxId", "lastReplyBy", "lastReplyAt"
      ) VALUES (
        ${id}, ${tenantId}, ${subject}, ${description}, ${type}, ${priority}, 'portal', ${forContactId}, ${vehicleId}, ${staff?.id ?? null},
        ${mailboxId}, 'customer', CURRENT_TIMESTAMP
      )
    `;
    await basePrisma.$executeRaw`
      INSERT INTO "CustomerCaseMessage" ("id", "tenantId", "caseId", "contactId", "direction", "type", "body")
      VALUES (${crypto.randomUUID()}, ${tenantId}, ${id}, ${contact.id}, 'customer', 'customer', ${description})
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
    // The message named no tenant column at all, so it landed unowned however the
    // scope resolved; the case UPDATE named no tenant either, and runs on the
    // bypass client. portalCanAccessCase() above is an access check, not a tenant
    // predicate, and it is the only thing between a caseId from the form post and
    // a write.
    //
    // The owner comes from the CASE, not from the viewer. `CustomerCaseMessage`
    // has a composite FK `(tenantId, caseId) → CustomerCase(tenantId, id)`, so a
    // reply stamped with the viewer's tenant against a still-tenantless case
    // produces `(tenant_denago_cpt, C1)` for a parent of `(NULL, C1)` — Postgres
    // rejects it and the customer can no longer reply at all. Production is full
    // of exactly those cases, awaiting backfill.
    const tenantId = await tenantOfCase(caseId);
    await basePrisma.$transaction([
      basePrisma.$executeRaw`
        INSERT INTO "CustomerCaseMessage" ("id", "tenantId", "caseId", "contactId", "direction", "type", "body")
        VALUES (${crypto.randomUUID()}, ${tenantId}, ${caseId}, ${contact.id}, 'customer', 'customer', ${body})
      `,
      basePrisma.$executeRaw`
        UPDATE "CustomerCase" SET "status" = CASE
            WHEN "status" IN ('resolved', 'closed', 'cancelled') THEN 'open'
            WHEN "status" = 'waiting_customer' THEN 'waiting_internal'
            ELSE "status" END,
          "lastReplyAt" = CURRENT_TIMESTAMP, "lastReplyBy" = 'customer',
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${caseId} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
      `,
    ]);
    const rows = await basePrisma.$queryRaw<Array<{ number: bigint }>>`
      SELECT "number" FROM "CustomerCase" WHERE "id" = ${caseId}
    `;
    const number = rows[0]?.number?.toString() ?? "new";
    await sendPushToAll({
      title: `Customer replied to C-${number}`,
      body: body.slice(0, 120),
      url: `/cases/${caseId}`,
    }, "portal_case").catch(() => {});
    revalidatePath(`/portal/support/${caseId}`);
    revalidatePath("/cases");
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
    // Ignore any posted vehicle link when the automotive pack is off.
    const vehicleId = (await isModuleEnabled("automotive"))
      ? text(formData.get("vehicleId")) || null
      : null;
    const caseId = text(formData.get("caseId")) || null;
    if (vehicleId && !(await portalCanAccessVehicle(vehicleId))) return { error: "Vehicle not found." };
    if (caseId && !(await portalCanAccessCase(caseId))) return { error: "Case not found." };

    const buffer = Buffer.from(await file.arrayBuffer());
    const storedName = await saveFile(buffer, file.name, file.type);
    const tenantId = await portalTenantId(contact.id);
    await basePrisma.$executeRaw`
      INSERT INTO "PortalUpload" (
        "id", "tenantId", "contactId", "caseId", "vehicleId", "fileName", "storedName", "mimeType", "sizeBytes"
      ) VALUES (
        ${crypto.randomUUID()}, ${tenantId}, ${contact.id}, ${caseId}, ${vehicleId}, ${file.name}, ${storedName}, ${file.type}, ${file.size}
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
