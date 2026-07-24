import crypto from "node:crypto";
import { basePrisma } from "./db";
import { assertCampaignTransition, isCampaignLaunchable } from "./campaignLifecycle";
import { readCampaignDraftRecord } from "./marketingCampaignDrafts";
import { resolveContacts, newToken, type SegmentCriteria } from "./campaigns";

export type CampaignQaIssue = { code: string; message: string; severity: "error" | "warning" };

function validUrl(value: string | null) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function mergeVariables(value: string) {
  return [...value.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((match) => match[1]);
}

const ALLOWED_MERGE_VARIABLES = new Set(["first_name", "name"]);

export async function campaignQa(id: string, tenantId: string | null): Promise<CampaignQaIssue[]> {
  const campaign = await readCampaignDraftRecord(id, tenantId);
  if (!campaign) return [{ code: "missing", message: "Campaign not found", severity: "error" }];
  const issues: CampaignQaIssue[] = [];
  if (!campaign.name.trim()) issues.push({ code: "name", message: "Campaign name is required", severity: "error" });
  if (!campaign.objective?.trim()) issues.push({ code: "objective", message: "Campaign objective is required", severity: "error" });
  if (!new Set(["email", "sms"]).has(campaign.channel)) issues.push({ code: "channel", message: "Choose a supported channel", severity: "error" });
  if (campaign.channel === "email" && !campaign.subject?.trim()) issues.push({ code: "subject", message: "Email campaigns require a subject", severity: "error" });
  const content = campaign.channel === "email" ? campaign.htmlBody ?? campaign.body : campaign.body;
  if (!content.trim()) issues.push({ code: "content", message: "Campaign content cannot be blank", severity: "error" });
  if (!campaign.audience.trim() || campaign.audience === "Audience not selected") issues.push({ code: "audience", message: "Choose a valid audience", severity: "error" });
  if (!validUrl(campaign.landingPageUrl)) issues.push({ code: "landing_url", message: "Landing page URL is invalid", severity: "error" });
  if (!validUrl(campaign.primaryCtaUrl)) issues.push({ code: "cta_url", message: "CTA URL is invalid", severity: "error" });
  for (const variable of mergeVariables(`${campaign.subject ?? ""}\n${campaign.body}\n${campaign.htmlBody ?? ""}`)) {
    if (!ALLOWED_MERGE_VARIABLES.has(variable)) issues.push({ code: "merge_variable", message: `Unsupported merge variable: ${variable}`, severity: "error" });
  }
  if (campaign.channel === "email" && !/unsubscribe/i.test(campaign.htmlBody ?? "")) {
    issues.push({ code: "unsubscribe", message: "The delivery shell will add unsubscribe support; verify the final preview before launch", severity: "warning" });
  }
  return issues;
}

async function campaignSnapshot(id: string, tenantId: string | null) {
  const rows = await basePrisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT * FROM "Campaign" WHERE "id" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId} LIMIT 1
  `;
  if (!rows[0]) throw new Error("Campaign not found");
  return rows[0];
}

export async function saveCampaignVersion(args: {
  campaignId: string;
  tenantId: string | null;
  reason: string;
  userId: string;
  userName: string;
}) {
  const snapshot = await campaignSnapshot(args.campaignId, args.tenantId);
  const rows = await basePrisma.$queryRaw<Array<{ version: number }>>`
    SELECT COALESCE(MAX("version"), 0) + 1 AS "version" FROM "CampaignVersion" WHERE "campaignId" = ${args.campaignId}
  `;
  const version = Number(rows[0]?.version ?? 1);
  await basePrisma.$executeRaw`
    INSERT INTO "CampaignVersion" ("id", "tenantId", "campaignId", "version", "snapshot", "reason", "createdById", "createdByName", "createdAt")
    VALUES (${`cv_${crypto.randomUUID()}`}, ${args.tenantId}, ${args.campaignId}, ${version}, ${JSON.stringify(snapshot)}::jsonb, ${args.reason}, ${args.userId}, ${args.userName}, CURRENT_TIMESTAMP)
  `;
  await basePrisma.$executeRaw`UPDATE "Campaign" SET "version" = ${version}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${args.campaignId}`;
  return version;
}

export async function transitionCampaign(args: {
  campaignId: string;
  tenantId: string | null;
  from: string;
  to: string;
  userId: string;
  userName: string;
  note?: string | null;
}) {
  assertCampaignTransition(args.from, args.to);
  const fields: Record<string, Date | string | null> = {};
  const now = new Date();
  if (args.to === "in_review") fields.submittedForReviewAt = now;
  if (args.to === "approved") { fields.approvedAt = now; fields.approvedById = args.userId; fields.reviewNote = args.note ?? null; }
  if (args.to === "changes_requested") { fields.changesRequestedAt = now; fields.reviewNote = args.note ?? null; }
  if (args.to === "paused") fields.pausedAt = now;
  if (args.to === "cancelled") fields.cancelledAt = now;
  if (args.to === "archived") fields.archivedAt = now;
  const updated = await basePrisma.$executeRaw`
    UPDATE "Campaign" SET
      "status" = ${args.to},
      "submittedForReviewAt" = COALESCE(${fields.submittedForReviewAt ?? null}, "submittedForReviewAt"),
      "approvedAt" = COALESCE(${fields.approvedAt ?? null}, "approvedAt"),
      "approvedById" = COALESCE(${fields.approvedById ?? null}, "approvedById"),
      "changesRequestedAt" = COALESCE(${fields.changesRequestedAt ?? null}, "changesRequestedAt"),
      "reviewNote" = COALESCE(${fields.reviewNote ?? null}, "reviewNote"),
      "pausedAt" = COALESCE(${fields.pausedAt ?? null}, "pausedAt"),
      "cancelledAt" = COALESCE(${fields.cancelledAt ?? null}, "cancelledAt"),
      "archivedAt" = COALESCE(${fields.archivedAt ?? null}, "archivedAt"),
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${args.campaignId} AND "tenantId" IS NOT DISTINCT FROM ${args.tenantId} AND "status" = ${args.from}
  `;
  if (updated !== 1) throw new Error("Campaign changed while this action was being processed");
}

async function criteriaForCampaign(campaignId: string, tenantId: string | null): Promise<SegmentCriteria> {
  const rows = await basePrisma.$queryRaw<Array<{ segmentId: string | null; audienceSnapshot: unknown }>>`
    SELECT "segmentId", "audienceSnapshot" FROM "Campaign" WHERE "id" = ${campaignId} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
  `;
  const row = rows[0];
  if (!row) throw new Error("Campaign not found");
  if (row.segmentId) {
    const segment = await basePrisma.segment.findFirst({ where: { id: row.segmentId, tenantId } });
    if (segment) return JSON.parse(segment.criteria) as SegmentCriteria;
  }
  return (row.audienceSnapshot && typeof row.audienceSnapshot === "object" ? row.audienceSnapshot : {}) as SegmentCriteria;
}

export async function freezeAudienceAndQueue(args: {
  campaignId: string;
  tenantId: string | null;
  scheduleFor?: Date | null;
}) {
  const campaign = await readCampaignDraftRecord(args.campaignId, args.tenantId);
  if (!campaign) throw new Error("Campaign not found");
  if (!isCampaignLaunchable(campaign.status)) throw new Error("Only approved campaigns may be scheduled or queued");
  if (args.scheduleFor && args.scheduleFor <= new Date()) throw new Error("Scheduled time must be in the future");
  const criteria = await criteriaForCampaign(args.campaignId, args.tenantId);
  const contacts = await resolveContacts(criteria, campaign.channel);
  if (contacts.length === 0) throw new Error("No eligible recipients match this audience");

  await basePrisma.$transaction(async (tx) => {
    await tx.campaignRecipient.deleteMany({ where: { campaignId: args.campaignId, status: { in: ["pending", "queued"] } } });
    for (const contact of contacts) {
      await tx.campaignRecipient.create({
        data: {
          campaignId: args.campaignId,
          contactId: contact.id,
          token: newToken(),
          status: args.scheduleFor ? "pending" : "queued",
          tenantId: args.tenantId,
        },
      });
    }
    await tx.$executeRaw`
      UPDATE "Campaign" SET
        "audienceSnapshot" = ${JSON.stringify(criteria)}::jsonb,
        "recipientCount" = ${contacts.length},
        "scheduledFor" = ${args.scheduleFor ?? null},
        "status" = ${args.scheduleFor ? "scheduled" : "queued"},
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${args.campaignId} AND "tenantId" IS NOT DISTINCT FROM ${args.tenantId} AND "status" = 'approved'
    `;
  });
  return contacts.length;
}
