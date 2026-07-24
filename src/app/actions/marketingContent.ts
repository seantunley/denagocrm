"use server";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { getActiveTenantId } from "@/lib/auth";
import { basePrisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { requireModuleEnabled } from "@/lib/modules/enabled";
import { evaluateAudience, saveAudienceVersion, validateAudienceTree, type AudienceGroup } from "@/lib/marketingAudiences";
import { logAuditStrict } from "@/lib/audit";

const TEMPLATE_CATEGORIES = new Set([
  "marketing_email", "marketing_sms", "transactional", "service", "survey", "internal",
]);

function json<T>(value: FormDataEntryValue | null): T {
  try { return JSON.parse(String(value ?? "")) as T; } catch { throw new Error("Invalid JSON definition"); }
}

async function contentContext(permission: Parameters<typeof requirePermission>[0]) {
  await requireModuleEnabled("marketing");
  const user = await requirePermission(permission);
  return { user, tenantId: await getActiveTenantId() };
}

export async function createMarketingAudience(formData: FormData) {
  const { user, tenantId } = await contentContext("campaigns.manage_audiences");
  const name = String(formData.get("name") ?? "").trim();
  const tree = validateAudienceTree(json<AudienceGroup>(formData.get("ruleTree")));
  if (!name) throw new Error("Audience name is required");
  const id = `seg_${crypto.randomUUID()}`;
  await basePrisma.$executeRaw`
    INSERT INTO "Segment" ("id", "tenantId", "name", "criteria", "ruleTree", "status", "createdAt", "updatedAt")
    VALUES (${id}, ${tenantId}, ${name}, ${JSON.stringify(tree)}, ${JSON.stringify(tree)}::jsonb, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `;
  try {
    const result = await saveAudienceVersion({ segmentId: id, tenantId, tree, userId: user.id, userName: user.name });
    await logAuditStrict({ action: "audience.created", summary: `Created audience “${name}” (${result.count} contacts)`, entityType: "Segment", entityId: id, user, after: { name, ...result } });
  } catch (error) {
    await basePrisma.$executeRaw`DELETE FROM "Segment" WHERE "id" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}`;
    throw error;
  }
  revalidatePath("/marketing/audiences");
}

export async function updateMarketingAudience(id: string, formData: FormData) {
  const { user, tenantId } = await contentContext("campaigns.manage_audiences");
  const tree = validateAudienceTree(json<AudienceGroup>(formData.get("ruleTree")));
  const result = await saveAudienceVersion({ segmentId: id, tenantId, tree, userId: user.id, userName: user.name });
  await logAuditStrict({ action: "audience.updated", summary: `Updated audience version ${result.version}`, entityType: "Segment", entityId: id, user, after: result });
  revalidatePath("/marketing/audiences");
}

export async function previewMarketingAudience(formData: FormData) {
  await requireModuleEnabled("marketing");
  await requirePermission("campaigns.manage_audiences");
  const tree = validateAudienceTree(json<AudienceGroup>(formData.get("ruleTree")));
  const channel = String(formData.get("channel") ?? "any");
  if (!new Set(["any", "email", "sms"]).has(channel)) throw new Error("Unsupported preview channel");
  const contacts = await evaluateAudience(tree, channel);
  return contacts.slice(0, 20).map((contact) => ({
    id: contact.id,
    name: `${contact.firstName} ${contact.lastName ?? ""}`.trim(),
    email: contact.email,
    phone: contact.whatsapp ?? contact.phone,
  }));
}

export async function archiveMarketingAudience(id: string) {
  const { user, tenantId } = await contentContext("campaigns.manage_audiences");
  const updated = await basePrisma.$executeRaw`
    UPDATE "Segment"
    SET "status" = 'archived', "archivedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${id}
      AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
      AND COALESCE("status", 'active') <> 'archived'
  `;
  if (updated !== 1) throw new Error("Audience not found or already archived");
  await logAuditStrict({ action: "audience.archived", summary: "Archived marketing audience", entityType: "Segment", entityId: id, user });
  revalidatePath("/marketing/audiences");
}

type TemplateRow = {
  id: string;
  tenantId: string | null;
  name: string;
  subject: string;
  body: string;
  category: string;
  status: string;
  plainTextBody: string | null;
  version: number;
};

function templateInput(formData: FormData) {
  const id = String(formData.get("id") ?? "").trim() || `mt_${crypto.randomUUID()}`;
  const name = String(formData.get("name") ?? "").trim();
  const category = String(formData.get("category") ?? "marketing_email").trim();
  const subject = String(formData.get("subject") ?? "").trim();
  const body = String(formData.get("body") ?? "");
  const plainTextBody = String(formData.get("plainTextBody") ?? "").trim() || null;
  if (!name || !body.trim()) throw new Error("Template name and body are required");
  if (!TEMPLATE_CATEGORIES.has(category)) throw new Error("Unsupported template category");
  if (category === "marketing_email" && !subject) throw new Error("Email templates require a subject");
  return { id, name, category, subject, body, plainTextBody };
}

export async function saveMarketingTemplate(formData: FormData) {
  const { user, tenantId } = await contentContext("campaigns.manage_templates");
  const input = templateInput(formData);
  const version = await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`marketing-template:${input.id}`}))`;
    const allRows = await tx.$queryRaw<Array<{ tenantId: string | null }>>`
      SELECT "tenantId" FROM "EmailTemplate" WHERE "id" = ${input.id} FOR UPDATE
    `;
    if (allRows[0] && allRows[0].tenantId !== tenantId) throw new Error("Template belongs to another tenant");
    const existing = await tx.$queryRaw<TemplateRow[]>`
      SELECT "id", "tenantId", "name", "subject", "body", "category", "status", "plainTextBody", "version"
      FROM "EmailTemplate"
      WHERE "id" = ${input.id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
      LIMIT 1
    `;
    if (existing[0] && existing[0].status !== "draft") {
      throw new Error("Published or archived templates cannot be edited in place");
    }
    if (existing[0]) {
      const updated = await tx.$executeRaw`
        UPDATE "EmailTemplate"
        SET "name" = ${input.name}, "subject" = ${input.subject}, "body" = ${input.body},
          "category" = ${input.category}, "plainTextBody" = ${input.plainTextBody}, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${input.id}
          AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
          AND "status" = 'draft'
      `;
      if (updated !== 1) throw new Error("Template changed while saving");
    } else {
      await tx.$executeRaw`
        INSERT INTO "EmailTemplate" (
          "id", "tenantId", "name", "subject", "body", "category", "status", "plainTextBody", "version", "createdAt", "updatedAt"
        ) VALUES (
          ${input.id}, ${tenantId}, ${input.name}, ${input.subject}, ${input.body}, ${input.category},
          'draft', ${input.plainTextBody}, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `;
    }
    const rows = await tx.$queryRaw<Array<{ version: number }>>`
      SELECT COALESCE(MAX("version"), 0) + 1 AS "version"
      FROM "MarketingTemplateVersion"
      WHERE "templateId" = ${input.id}
        AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
    `;
    const next = Number(rows[0]?.version ?? 1);
    const snapshot = { ...input, status: "draft", version: next };
    await tx.$executeRaw`
      INSERT INTO "MarketingTemplateVersion" (
        "id", "tenantId", "templateId", "version", "snapshot", "reason", "createdById", "createdByName"
      ) VALUES (
        ${`mtv_${crypto.randomUUID()}`}, ${tenantId}, ${input.id}, ${next},
        ${JSON.stringify(snapshot)}::jsonb, 'Saved template version', ${user.id}, ${user.name}
      )
    `;
    const updated = await tx.$executeRaw`
      UPDATE "EmailTemplate" SET "version" = ${next}
      WHERE "id" = ${input.id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
    `;
    if (updated !== 1) throw new Error("Template disappeared while versioning");
    return next;
  });
  await logAuditStrict({ action: "template.updated", summary: `Saved marketing template “${input.name}” version ${version}`, entityType: "EmailTemplate", entityId: input.id, user, after: { ...input, version, status: "draft" } });
  revalidatePath("/marketing/templates");
}

export async function publishMarketingTemplate(id: string) {
  const { user, tenantId } = await contentContext("campaigns.manage_templates");
  const version = await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`marketing-template:${id}`}))`;
    const rows = await tx.$queryRaw<TemplateRow[]>`
      SELECT "id", "tenantId", "name", "subject", "body", "category", "status", "plainTextBody", "version"
      FROM "EmailTemplate"
      WHERE "id" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
      FOR UPDATE
    `;
    const template = rows[0];
    if (!template) throw new Error("Template not found");
    if (template.status !== "draft") throw new Error("Only a draft template can be published");
    const versions = await tx.$queryRaw<Array<{ version: number }>>`
      SELECT COALESCE(MAX("version"), 0) + 1 AS "version"
      FROM "MarketingTemplateVersion"
      WHERE "templateId" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
    `;
    const next = Number(versions[0]?.version ?? template.version + 1);
    const snapshot = { ...template, status: "published", version: next };
    await tx.$executeRaw`
      INSERT INTO "MarketingTemplateVersion" (
        "id", "tenantId", "templateId", "version", "snapshot", "reason", "createdById", "createdByName"
      ) VALUES (
        ${`mtv_${crypto.randomUUID()}`}, ${tenantId}, ${id}, ${next},
        ${JSON.stringify(snapshot)}::jsonb, 'Published immutable template', ${user.id}, ${user.name}
      )
    `;
    const updated = await tx.$executeRaw`
      UPDATE "EmailTemplate"
      SET "status" = 'published', "version" = ${next}, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${id}
        AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
        AND "status" = 'draft'
    `;
    if (updated !== 1) throw new Error("Template changed before publication");
    return next;
  });
  await logAuditStrict({ action: "template.published", summary: `Published marketing template version ${version}`, entityType: "EmailTemplate", entityId: id, user, after: { status: "published", version } });
  revalidatePath("/marketing/templates");
}

export async function archiveMarketingTemplate(id: string) {
  const { user, tenantId } = await contentContext("campaigns.manage_templates");
  const updated = await basePrisma.$executeRaw`
    UPDATE "EmailTemplate"
    SET "status" = 'archived', "archivedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${id}
      AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
      AND "status" <> 'archived'
  `;
  if (updated !== 1) throw new Error("Template not found or already archived");
  await logAuditStrict({ action: "template.archived", summary: "Archived marketing template", entityType: "EmailTemplate", entityId: id, user });
  revalidatePath("/marketing/templates");
}
