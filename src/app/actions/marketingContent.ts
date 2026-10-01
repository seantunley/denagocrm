"use server";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { getActiveTenantId } from "@/lib/auth";
import { basePrisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { requireModuleEnabled } from "@/lib/modules/enabled";
import {
  evaluateAudience,
  saveAudienceVersion,
  validateAudienceReferences,
  validateAudienceTree,
  type AudienceGroup,
} from "@/lib/marketingAudiences";
import { logAuditStrict } from "@/lib/audit";
import { withActingStaffScope } from "@/lib/actingScope";
import { asActionResult, refuse, ActionRefusal } from "@/lib/actionResult";

// Keep historical categories readable/editable while making the governed
// Marketing workspace's purpose-specific categories authoritative for new work.
const TEMPLATE_CATEGORIES = new Set([
  "marketing_email",
  "marketing_sms",
  "transactional_email",
  "transactional_sms",
  "service_reminder",
  "survey_invite_email",
  "survey_invite_sms",
  "internal_notification",
  // Historical values retained for existing rows.
  "transactional",
  "service",
  "survey",
  "internal",
]);
const EMAIL_TEMPLATE_CATEGORIES = new Set([
  "marketing_email",
  "transactional_email",
  "survey_invite_email",
  "service_reminder",
]);

function json<T>(value: FormDataEntryValue | null): T {
  try { return JSON.parse(String(value ?? "")) as T; } catch { refuse("Those audience rules couldn't be read — refresh and try again."); }
}

/*
 * asActionResult on every mutation (gap audit #22). The workspaces call these
 * directly and showed `caught.message` — but a message thrown from a Server
 * Action is redacted in production, so staff got a generic failure for "every
 * group needs a rule" or "published templates can't be edited". Several of these
 * also bound no workspace at all; asActionResult binds it.
 */

async function contentContext(permission: Parameters<typeof requirePermission>[0]) {
  await requireModuleEnabled("marketing");
  const user = await requirePermission(permission);
  return { user, tenantId: await getActiveTenantId() };
}

export async function createMarketingAudience(formData: FormData) {
  return asActionResult(async () => {
  const { user, tenantId } = await contentContext("campaigns.manage_audiences");
  const name = String(formData.get("name") ?? "").trim();
  const tree = validateAudienceTree(json<AudienceGroup>(formData.get("ruleTree")));
  if (!name) refuse("Give the audience a name.");
  await validateAudienceReferences(tree, tenantId);

  const id = `seg_${crypto.randomUUID()}`;
  await basePrisma.$executeRaw`
    INSERT INTO "Segment" ("id", "tenantId", "name", "criteria", "ruleTree", "status", "createdAt", "updatedAt")
    VALUES (${id}, ${tenantId}, ${name}, ${JSON.stringify(tree)}, ${JSON.stringify(tree)}::jsonb, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `;
  try {
    const result = await saveAudienceVersion({ segmentId: id, tenantId, tree, userId: user.id, userName: user.name, name });
    await logAuditStrict({ action: "audience.created", summary: `Created audience “${name}” (${result.count} contacts)`, entityType: "Segment", entityId: id, user, after: { name, ...result } });
  } catch (error) {
    await basePrisma.$executeRaw`DELETE FROM "Segment" WHERE "id" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}`;
    throw error;
  }
  revalidatePath("/marketing/audiences");
  return { success: "Audience created" };
  });
}

export async function updateMarketingAudience(id: string, formData: FormData) {
  return asActionResult(async () => {
    const { user, tenantId } = await contentContext("campaigns.manage_audiences");
    const tree = validateAudienceTree(json<AudienceGroup>(formData.get("ruleTree")));
    const submittedName = formData.get("name");
    const name = submittedName === null ? undefined : String(submittedName).trim();
    if (submittedName !== null && !name) refuse("Give the audience a name.");
    await validateAudienceReferences(tree, tenantId);

    const result = await saveAudienceVersion({ segmentId: id, tenantId, tree, userId: user.id, userName: user.name, name });
    await logAuditStrict({ action: "audience.updated", summary: `Updated audience version ${result.version}`, entityType: "Segment", entityId: id, user, after: { ...result, name } });
    revalidatePath("/marketing/audiences");
    return { success: "Audience version saved" };
  });
}

export type AudiencePreview = {
  total: number;
  channelCount: number;
  emailCount: number;
  smsCount: number;
  contacts: Array<{ id: string; name: string; email: string | null; phone: string | null }>;
};

/** A preview, or the reason the rules can't be previewed (returned, so it isn't redacted). */
export async function previewMarketingAudience(formData: FormData): Promise<AudiencePreview | { error: string }> {
  return withActingStaffScope(async () => {
    try {
      return await previewMarketingAudienceBody(formData);
    } catch (error) {
      if (error instanceof ActionRefusal) return { error: error.message };
      throw error;
    }
  });
}

async function previewMarketingAudienceBody(formData: FormData): Promise<AudiencePreview> {
  {
    const { tenantId } = await contentContext("campaigns.manage_audiences");
    const tree = validateAudienceTree(json<AudienceGroup>(formData.get("ruleTree")));
    const channel = String(formData.get("channel") ?? "any");
    if (!new Set(["any", "email", "sms"]).has(channel)) refuse("Choose any, email or SMS for the preview.");
    await validateAudienceReferences(tree, tenantId);

    // Resolve once so the preview can explain reachability without three full
    // database/evaluation passes. evaluateAudience itself remains tenant-scoped and
    // excludes deleted/marketing-opted-out contacts.
    const contacts = await evaluateAudience(tree, "any", tenantId);
    const emailCount = contacts.filter((contact) => Boolean(contact.email)).length;
    const smsCount = contacts.filter((contact) => Boolean(contact.whatsapp || contact.phone)).length;
    const selected = channel === "email"
      ? contacts.filter((contact) => Boolean(contact.email))
      : channel === "sms"
        ? contacts.filter((contact) => Boolean(contact.whatsapp || contact.phone))
        : contacts;

    return {
      total: contacts.length,
      channelCount: selected.length,
      emailCount,
      smsCount,
      contacts: selected.slice(0, 20).map((contact) => ({
        id: contact.id,
        name: `${contact.firstName} ${contact.lastName ?? ""}`.trim(),
        email: contact.email,
        phone: contact.whatsapp ?? contact.phone,
      })),
    };
  }
}

export async function archiveMarketingAudience(id: string) {
  return asActionResult(async () => {
  const { user, tenantId } = await contentContext("campaigns.manage_audiences");
  const updated = await basePrisma.$executeRaw`
    UPDATE "Segment"
    SET "status" = 'archived', "archivedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${id}
      AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
      AND COALESCE("status", 'active') <> 'archived'
  `;
  if (updated !== 1) refuse("That audience is already archived or gone — refresh the page.");
  await logAuditStrict({ action: "audience.archived", summary: "Archived marketing audience", entityType: "Segment", entityId: id, user });
  revalidatePath("/marketing/audiences");
  return { success: "Audience archived" };
  });
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
  if (!name || !body.trim()) refuse("Give the template a name and a body.");
  if (!TEMPLATE_CATEGORIES.has(category)) refuse("Choose a template category.");
  if (EMAIL_TEMPLATE_CATEGORIES.has(category) && !subject) refuse("Email templates need a subject line.");
  return { id, name, category, subject, body, plainTextBody };
}

export async function saveMarketingTemplate(formData: FormData) {
  return asActionResult(async () => {
  const { user, tenantId } = await contentContext("campaigns.manage_templates");
  const input = templateInput(formData);
  const version = await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`marketing-template:${input.id}`}))`;
    // Deliberately look up the globally unique id without tenant scope first so a
    // crafted request cannot update another tenant's template by guessing its id.
    const allRows = await tx.$queryRaw<Array<{ tenantId: string | null }>>`
      SELECT "tenantId" FROM "EmailTemplate" WHERE "id" = ${input.id} FOR UPDATE
    `;
    if (allRows[0] && allRows[0].tenantId !== tenantId) refuse("Template belongs to another tenant");
    const existing = await tx.$queryRaw<TemplateRow[]>`
      SELECT "id", "tenantId", "name", "subject", "body", "category", "status", "plainTextBody", "version"
      FROM "EmailTemplate"
      WHERE "id" = ${input.id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
      LIMIT 1
    `;
    if (existing[0] && existing[0].status !== "draft") {
      refuse("Published and archived templates can't be edited — use it as a new draft instead.");
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
      if (updated !== 1) refuse("Someone else changed this template while you were saving — refresh and try again.");
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
    if (updated !== 1) refuse("That template was removed while saving — refresh the page.");
    return next;
  });
  await logAuditStrict({ action: "template.updated", summary: `Saved marketing template “${input.name}” version ${version}`, entityType: "EmailTemplate", entityId: input.id, user, after: { ...input, version, status: "draft" } });
  revalidatePath("/marketing/templates");
  return { success: "Draft saved" };
  });
}

export async function publishMarketingTemplate(id: string) {
  return asActionResult(async () => {
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
    if (!template) refuse("That template is no longer there — refresh the page.");
    if (template.status !== "draft") refuse("Only a draft template can be published.");
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
    if (updated !== 1) refuse("Someone else changed this template first — refresh and try again.");
    return next;
  });
  await logAuditStrict({ action: "template.published", summary: `Published marketing template version ${version}`, entityType: "EmailTemplate", entityId: id, user, after: { status: "published", version } });
  revalidatePath("/marketing/templates");
  return { success: `Published v${version}` };
  });
}

export async function archiveMarketingTemplate(id: string) {
  return asActionResult(async () => {
  const { user, tenantId } = await contentContext("campaigns.manage_templates");
  const updated = await basePrisma.$executeRaw`
    UPDATE "EmailTemplate"
    SET "status" = 'archived', "archivedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${id}
      AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
      AND "status" <> 'archived'
  `;
  if (updated !== 1) refuse("That template is already archived or gone — refresh the page.");
  await logAuditStrict({ action: "template.archived", summary: "Archived marketing template", entityType: "EmailTemplate", entityId: id, user });
  revalidatePath("/marketing/templates");
  return { success: "Template archived" };
  });
}

/**
 * Render a draft template body exactly as a campaign send would.
 *
 * Read-only on purpose: no rows written, no audit entry — it is the same
 * permission gate as every template action followed by a pure render. The body
 * comes from the editor the caller is typing into, and the result goes into a
 * SANDBOXED iframe, so the only consumer of this HTML is an inert document.
 */
export async function previewMarketingEmailTemplate(bodyHtml: string): Promise<string> {
  const { tenantId } = await contentContext("campaigns.manage_templates");
  const { emailPreviewHtml } = await import("@/lib/campaigns");
  const { emailBrand } = await import("@/lib/emailBrand");
  // Cap what a preview will chew on; a template body near this size has bigger
  // problems than its preview, and this action runs on every debounced keystroke.
  const body = String(bodyHtml ?? "").slice(0, 200_000);
  return emailPreviewHtml(body, await emailBrand(tenantId));
}
