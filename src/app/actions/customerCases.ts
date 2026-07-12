"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { basePrisma } from "@/lib/db";
import { requireOperational } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

const text = (formData: FormData, key: string) => String(formData.get(key) ?? "").trim();

async function notifyCustomer(contactId: string, title: string, body: string, href: string) {
  await basePrisma.$executeRaw`
    INSERT INTO "PortalNotification" ("id", "contactId", "title", "body", "href", "kind")
    VALUES (${crypto.randomUUID()}, ${contactId}, ${title}, ${body}, ${href}, 'case')
  `;
}

export async function replyToCustomerCase(caseId: string, formData: FormData) {
  const user = await requireOperational();
  const body = text(formData, "body");
  if (body.length < 2) throw new Error("Message is required");
  const rows = await basePrisma.$queryRaw<Array<{ contactId: string; number: bigint; status: string }>>`
    SELECT "contactId", "number", "status" FROM "CustomerCase" WHERE "id" = ${caseId} LIMIT 1
  `;
  const item = rows[0];
  if (!item) throw new Error("Case not found");

  await basePrisma.$transaction([
    basePrisma.$executeRaw`
      INSERT INTO "CustomerCaseMessage" ("id", "caseId", "userId", "direction", "body")
      VALUES (${crypto.randomUUID()}, ${caseId}, ${user.id}, 'staff', ${body})
    `,
    basePrisma.$executeRaw`
      UPDATE "CustomerCase"
      SET "status" = CASE WHEN "status" IN ('new', 'waiting_internal') THEN 'open' ELSE "status" END,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${caseId}
    `,
  ]);
  await notifyCustomer(item.contactId, `Update on case C-${item.number.toString()}`, body.slice(0, 180), `/portal/support/${caseId}`);
  await logAudit({
    action: "case.staff_reply",
    summary: `Staff replied to portal case C-${item.number.toString()}`,
    contactId: item.contactId,
    user,
    entityType: "CustomerCase",
    entityId: caseId,
  });
  revalidatePath(`/cases/${caseId}`);
}

export async function updateCustomerCaseStatus(caseId: string, formData: FormData) {
  const user = await requireOperational();
  const status = text(formData, "status");
  const allowed = new Set(["new", "open", "waiting_customer", "waiting_internal", "resolved", "closed", "cancelled"]);
  if (!allowed.has(status)) throw new Error("Invalid case status");
  const rows = await basePrisma.$queryRaw<Array<{ contactId: string; number: bigint; status: string }>>`
    SELECT "contactId", "number", "status" FROM "CustomerCase" WHERE "id" = ${caseId} LIMIT 1
  `;
  const item = rows[0];
  if (!item) throw new Error("Case not found");

  await basePrisma.$executeRaw`
    UPDATE "CustomerCase"
    SET "status" = ${status},
        "updatedAt" = CURRENT_TIMESTAMP,
        "resolvedAt" = CASE WHEN ${status} = 'resolved' THEN COALESCE("resolvedAt", CURRENT_TIMESTAMP) ELSE "resolvedAt" END,
        "closedAt" = CASE WHEN ${status} = 'closed' THEN COALESCE("closedAt", CURRENT_TIMESTAMP) ELSE "closedAt" END
    WHERE "id" = ${caseId}
  `;
  await notifyCustomer(item.contactId, `Case C-${item.number.toString()} status changed`, `Your case is now ${status.replaceAll("_", " ")}.`, `/portal/support/${caseId}`);
  await logAudit({
    action: "case.status_changed",
    summary: `Case C-${item.number.toString()} changed from ${item.status} to ${status}`,
    contactId: item.contactId,
    user,
    entityType: "CustomerCase",
    entityId: caseId,
    before: { status: item.status },
    after: { status },
  });
  revalidatePath("/cases");
  revalidatePath(`/cases/${caseId}`);
}
