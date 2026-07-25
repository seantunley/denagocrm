"use server";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { getActiveTenantId } from "@/lib/auth";
import { basePrisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { evaluateAudience, saveAudienceVersion, type AudienceGroup } from "@/lib/marketingAudiences";
import { logAuditStrict } from "@/lib/audit";

function json<T>(value: FormDataEntryValue | null): T {
  try { return JSON.parse(String(value ?? "")) as T; } catch { throw new Error("Invalid JSON definition"); }
}

export async function createMarketingAudience(formData: FormData) {
  const user = await requirePermission("campaigns.manage_audiences");
  const tenantId = await getActiveTenantId();
  const name = String(formData.get("name") ?? "").trim();
  const tree = json<AudienceGroup>(formData.get("ruleTree"));
  if (!name) throw new Error("Audience name is required");
  const id = `seg_${crypto.randomUUID()}`;
  await basePrisma.$executeRaw`INSERT INTO "Segment" ("id", "tenantId", "name", "criteria", "ruleTree", "status", "createdAt", "updatedAt") VALUES (${id}, ${tenantId}, ${name}, ${JSON.stringify(tree)}, ${JSON.stringify(tree)}::jsonb, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
  const result = await saveAudienceVersion({ segmentId: id, tenantId, tree, userId: user.id, userName: user.name });
  await logAuditStrict({ action: "audience.created", summary: `Created audience “${name}” (${result.count} contacts)`, entityType: "Segment", entityId: id, user, after: { name, ...result } });
  revalidatePath("/marketing/audiences");
}

export async function updateMarketingAudience(id: string, formData: FormData) {
  const user = await requirePermission("campaigns.manage_audiences");
  const tenantId = await getActiveTenantId();
  const tree = json<AudienceGroup>(formData.get("ruleTree"));
  const result = await saveAudienceVersion({ segmentId: id, tenantId, tree, userId: user.id, userName: user.name });
  await logAuditStrict({ action: "audience.updated", summary: `Updated audience version ${result.version}`, entityType: "Segment", entityId: id, user, after: result });
  revalidatePath("/marketing/audiences");
}

export async function previewMarketingAudience(formData: FormData) {
  await requirePermission("campaigns.manage_audiences");
  const tenantId = await getActiveTenantId();
  const tree = json<AudienceGroup>(formData.get("ruleTree"));
  const channel = String(formData.get("channel") ?? "any");
  const contacts = await evaluateAudience(tree, channel, tenantId);
  return contacts.slice(0, 20).map((contact) => ({ id: contact.id, name: `${contact.firstName} ${contact.lastName ?? ""}`.trim(), email: contact.email, phone: contact.whatsapp ?? contact.phone }));
}

export async function archiveMarketingAudience(id: string) {
  const user = await requirePermission("campaigns.manage_audiences");
  const tenantId = await getActiveTenantId();
  const updated = await basePrisma.$executeRaw`UPDATE "Segment" SET "status" = 'archived', "archivedAt" = CURRENT_TIMESTAMP WHERE "id" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId} AND COALESCE("status", 'active') <> 'archived'`;
  if (updated !== 1) throw new Error("Audience not found or already archived");
  await logAuditStrict({ action: "audience.archived", summary: "Archived marketing audience", entityType: "Segment", entityId: id, user });
  revalidatePath("/marketing/audiences");
}

export async function saveMarketingTemplate(formData: FormData) {
  const user = await requirePermission("campaigns.manage_templates");
  const tenantId = await getActiveTenantId();
  const id = String(formData.get("id") ?? "").trim() || `mt_${crypto.randomUUID()}`;
  const name = String(formData.get("name") ?? "").trim();
  const category = String(formData.get("category") ?? "marketing_email");
  const subject = String(formData.get("subject") ?? "").trim();
  const body = String(formData.get("body") ?? "");
  const plainTextBody = String(formData.get("plainTextBody") ?? "");
  if (!name || !body) throw new Error("Template name and body are required");
  await basePrisma.$executeRaw`
    INSERT INTO "EmailTemplate" ("id", "tenantId", "name", "subject", "body", "category", "status", "plainTextBody", "version", "createdAt", "updatedAt")
    VALUES (${id}, ${tenantId}, ${name}, ${subject}, ${body}, ${category}, 'draft', ${plainTextBody || null}, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "subject" = EXCLUDED."subject", "body" = EXCLUDED."body", "category" = EXCLUDED."category", "plainTextBody" = EXCLUDED."plainTextBody", "updatedAt" = CURRENT_TIMESTAMP
  `;
  const rows = await basePrisma.$queryRaw<Array<{ version: number }>>`SELECT COALESCE(MAX("version"), 0) + 1 AS version FROM "MarketingTemplateVersion" WHERE "templateId" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}`;
  const version = Number(rows[0]?.version ?? 1);
  const snapshot = { name, category, subject, body, plainTextBody, status: "draft" };
  await basePrisma.$executeRaw`INSERT INTO "MarketingTemplateVersion" ("id", "tenantId", "templateId", "version", "snapshot", "reason", "createdById", "createdByName") VALUES (${`mtv_${crypto.randomUUID()}`}, ${tenantId}, ${id}, ${version}, ${JSON.stringify(snapshot)}::jsonb, 'Saved template version', ${user.id}, ${user.name})`;
  await basePrisma.$executeRaw`UPDATE "EmailTemplate" SET "version" = ${version} WHERE "id" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}`;
  await logAuditStrict({ action: "template.updated", summary: `Saved marketing template “${name}” version ${version}`, entityType: "EmailTemplate", entityId: id, user, after: snapshot });
  revalidatePath("/marketing/templates");
}

export async function publishMarketingTemplate(id: string) {
  const user = await requirePermission("campaigns.manage_templates");
  const tenantId = await getActiveTenantId();
  const updated = await basePrisma.$executeRaw`UPDATE "EmailTemplate" SET "status" = 'published', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}`;
  if (updated !== 1) throw new Error("Template not found");
  await logAuditStrict({ action: "template.published", summary: "Published marketing template", entityType: "EmailTemplate", entityId: id, user });
  revalidatePath("/marketing/templates");
}

export async function archiveMarketingTemplate(id: string) {
  const user = await requirePermission("campaigns.manage_templates");
  const tenantId = await getActiveTenantId();
  const updated = await basePrisma.$executeRaw`UPDATE "EmailTemplate" SET "status" = 'archived', "archivedAt" = CURRENT_TIMESTAMP WHERE "id" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}`;
  if (updated !== 1) throw new Error("Template not found");
  await logAuditStrict({ action: "template.archived", summary: "Archived marketing template", entityType: "EmailTemplate", entityId: id, user });
  revalidatePath("/marketing/templates");
}
