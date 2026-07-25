import crypto from "node:crypto";
import { basePrisma } from "./db";
import { assertCampaignTransition, isCampaignLaunchable, parseCampaignStatus } from "./campaignLifecycle";
import { readCampaignDraftRecord } from "./marketingCampaignDrafts";
import { resolveContacts, newToken, type SegmentCriteria } from "./campaigns";
import { evaluateAudience, validateAudienceTree, type AudienceGroup } from "./marketingAudiences";

export type CampaignQaIssue = { code: string; message: string; severity: "error" | "warning" };

type CampaignStateRow = {
  status: string;
  submittedById: string | null;
};

type TransactionClient = Pick<typeof basePrisma, "$queryRaw" | "$executeRaw" | "campaignRecipient">;

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

async function nextVersionAndSnapshot(
  tx: TransactionClient,
  args: { campaignId: string; tenantId: string | null; reason: string; userId: string; userName: string },
) {
  const campaigns = await tx.$queryRaw<Array<Record<string, unknown>>>`
    SELECT * FROM "Campaign"
    WHERE "id" = ${args.campaignId}
      AND "tenantId" IS NOT DISTINCT FROM ${args.tenantId}
    FOR UPDATE
  `;
  const snapshot = campaigns[0];
  if (!snapshot) throw new Error("Campaign not found");
  const rows = await tx.$queryRaw<Array<{ version: number }>>`
    SELECT COALESCE(MAX("version"), 0) + 1 AS "version"
    FROM "CampaignVersion"
    WHERE "campaignId" = ${args.campaignId}
      AND "tenantId" IS NOT DISTINCT FROM ${args.tenantId}
  `;
  const version = Number(rows[0]?.version ?? 1);
  await tx.$executeRaw`
    INSERT INTO "CampaignVersion" (
      "id", "tenantId", "campaignId", "version", "snapshot", "reason", "createdById", "createdByName", "createdAt"
    ) VALUES (
      ${`cv_${crypto.randomUUID()}`}, ${args.tenantId}, ${args.campaignId}, ${version},
      ${JSON.stringify(snapshot)}::jsonb, ${args.reason}, ${args.userId}, ${args.userName}, CURRENT_TIMESTAMP
    )
  `;
  const updated = await tx.$executeRaw`
    UPDATE "Campaign"
    SET "version" = ${version}, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${args.campaignId}
      AND "tenantId" IS NOT DISTINCT FROM ${args.tenantId}
  `;
  if (updated !== 1) throw new Error("Campaign disappeared while versioning");
  return version;
}

export async function saveCampaignVersion(args: {
  campaignId: string;
  tenantId: string | null;
  reason: string;
  userId: string;
  userName: string;
}) {
  return basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`campaign-version:${args.campaignId}`}))`;
    return nextVersionAndSnapshot(tx, args);
  });
}

async function updateCampaignState(
  tx: TransactionClient,
  args: {
    campaignId: string;
    tenantId: string | null;
    from: string;
    to: string;
    userId: string;
    note?: string | null;
  },
) {
  assertCampaignTransition(args.from, args.to);
  const rows = await tx.$queryRaw<CampaignStateRow[]>`
    SELECT "status", "submittedById"
    FROM "Campaign"
    WHERE "id" = ${args.campaignId}
      AND "tenantId" IS NOT DISTINCT FROM ${args.tenantId}
    FOR UPDATE
  `;
  const campaign = rows[0];
  if (!campaign || campaign.status !== args.from) throw new Error("Campaign changed while this action was being processed");
  if (args.to === "approved" && campaign.submittedById === args.userId) {
    throw new Error("The person who submitted a campaign cannot approve it");
  }
  if (args.to === "changes_requested" && !args.note?.trim()) throw new Error("Explain the required changes");

  const updated = await tx.$executeRaw`
    UPDATE "Campaign" SET
      "status" = ${args.to},
      "submittedForReviewAt" = CASE WHEN ${args.to} = 'in_review' THEN CURRENT_TIMESTAMP ELSE "submittedForReviewAt" END,
      "submittedById" = CASE WHEN ${args.to} = 'in_review' THEN ${args.userId} ELSE "submittedById" END,
      "approvedAt" = CASE WHEN ${args.to} = 'approved' THEN CURRENT_TIMESTAMP WHEN ${args.to} = 'draft' THEN NULL ELSE "approvedAt" END,
      "approvedById" = CASE WHEN ${args.to} = 'approved' THEN ${args.userId} WHEN ${args.to} = 'draft' THEN NULL ELSE "approvedById" END,
      "changesRequestedAt" = CASE WHEN ${args.to} = 'changes_requested' THEN CURRENT_TIMESTAMP ELSE "changesRequestedAt" END,
      "reviewNote" = CASE
        WHEN ${args.to} = 'changes_requested' THEN ${args.note?.trim() ?? null}
        WHEN ${args.to} IN ('in_review', 'approved', 'draft') THEN NULL
        ELSE "reviewNote"
      END,
      "pausedAt" = CASE WHEN ${args.to} = 'paused' THEN CURRENT_TIMESTAMP WHEN ${args.to} = 'queued' THEN NULL ELSE "pausedAt" END,
      "cancelledAt" = CASE WHEN ${args.to} = 'cancelled' THEN CURRENT_TIMESTAMP ELSE "cancelledAt" END,
      "archivedAt" = CASE WHEN ${args.to} = 'archived' THEN CURRENT_TIMESTAMP ELSE "archivedAt" END,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${args.campaignId}
      AND "tenantId" IS NOT DISTINCT FROM ${args.tenantId}
      AND "status" = ${args.from}
  `;
  if (updated !== 1) throw new Error("Campaign changed while this action was being processed");
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
  await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`campaign-state:${args.campaignId}`}))`;
    await updateCampaignState(tx, args);
  });
}

export async function transitionCampaignWithVersion(args: {
  campaignId: string;
  tenantId: string | null;
  from: string;
  to: string;
  userId: string;
  userName: string;
  reason: string;
  note?: string | null;
}) {
  return basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`campaign-state:${args.campaignId}`}))`;
    await updateCampaignState(tx, args);
    return nextVersionAndSnapshot(tx, args);
  });
}

type AudienceDefinition = {
  kind: "advanced" | "legacy";
  segmentId: string | null;
  definition: AudienceGroup | SegmentCriteria;
  version?: number | null;
};

function isAudienceGroup(value: unknown): value is AudienceGroup {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return (object.operator === "AND" || object.operator === "OR") && Array.isArray(object.rules);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

async function resolveCampaignAudience(args: { campaignId: string; tenantId: string | null; channel: string }) {
  const campaigns = await basePrisma.$queryRaw<Array<{ segmentId: string | null; audienceSnapshot: unknown }>>`
    SELECT "segmentId", "audienceSnapshot"
    FROM "Campaign"
    WHERE "id" = ${args.campaignId}
      AND "tenantId" IS NOT DISTINCT FROM ${args.tenantId}
    LIMIT 1
  `;
  const campaign = campaigns[0];
  if (!campaign) throw new Error("Campaign not found");

  let definition: AudienceDefinition;
  if (campaign.segmentId) {
    const segments = await basePrisma.$queryRaw<Array<{ criteria: unknown; ruleTree: unknown; latestVersion: number | null }>>`
      SELECT s."criteria", s."ruleTree",
        (SELECT MAX(v."version") FROM "MarketingAudienceVersion" v
          WHERE v."segmentId" = s."id" AND v."tenantId" IS NOT DISTINCT FROM s."tenantId") AS "latestVersion"
      FROM "Segment" s
      WHERE s."id" = ${campaign.segmentId}
        AND s."tenantId" IS NOT DISTINCT FROM ${args.tenantId}
        AND COALESCE(s."status", 'active') <> 'archived'
      LIMIT 1
    `;
    const segment = segments[0];
    if (!segment) throw new Error("The selected audience no longer exists");
    const tree = parseJson(segment.ruleTree);
    if (isAudienceGroup(tree)) {
      validateAudienceTree(tree);
      definition = { kind: "advanced", segmentId: campaign.segmentId, definition: tree, version: segment.latestVersion };
    } else {
      const criteria = parseJson(segment.criteria);
      definition = { kind: "legacy", segmentId: campaign.segmentId, definition: (criteria && typeof criteria === "object" ? criteria : {}) as SegmentCriteria, version: segment.latestVersion };
    }
  } else {
    const snapshot = parseJson(campaign.audienceSnapshot);
    if (isAudienceGroup(snapshot)) {
      validateAudienceTree(snapshot);
      definition = { kind: "advanced", segmentId: null, definition: snapshot };
    } else {
      definition = { kind: "legacy", segmentId: null, definition: (snapshot && typeof snapshot === "object" ? snapshot : {}) as SegmentCriteria };
    }
  }

  const contacts = definition.kind === "advanced"
    ? await evaluateAudience(definition.definition as AudienceGroup, args.channel, args.tenantId)
    : await resolveContacts(definition.definition as SegmentCriteria, args.channel);
  return { definition, contacts };
}

export async function freezeAudienceAndQueue(args: {
  campaignId: string;
  tenantId: string | null;
  scheduleFor?: Date | null;
  userId: string;
  userName: string;
  reason: string;
}) {
  const campaign = await readCampaignDraftRecord(args.campaignId, args.tenantId);
  if (!campaign) throw new Error("Campaign not found");
  if (!isCampaignLaunchable(parseCampaignStatus(campaign.status))) throw new Error("Only approved campaigns may be scheduled or queued");
  if (args.scheduleFor && args.scheduleFor <= new Date()) throw new Error("Scheduled time must be in the future");
  const { definition, contacts } = await resolveCampaignAudience({ campaignId: args.campaignId, tenantId: args.tenantId, channel: campaign.channel });
  const uniqueContacts = [...new Map(contacts.map((contact) => [contact.id, contact])).values()];
  if (uniqueContacts.length === 0) throw new Error("No eligible recipients match this audience");
  const exactSnapshot = {
    ...definition,
    resolvedAt: new Date().toISOString(),
    channel: campaign.channel,
    resolvedContactIds: uniqueContacts.map((contact) => contact.id),
  };

  return basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`campaign-state:${args.campaignId}`}))`;
    const locked = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT "status" FROM "Campaign"
      WHERE "id" = ${args.campaignId}
        AND "tenantId" IS NOT DISTINCT FROM ${args.tenantId}
      FOR UPDATE
    `;
    if (locked[0]?.status !== "approved") throw new Error("Campaign approval changed before launch");

    await tx.$executeRaw`
      DELETE FROM "CampaignRecipient"
      WHERE "campaignId" = ${args.campaignId}
        AND "tenantId" IS NOT DISTINCT FROM ${args.tenantId}
        AND "status" IN ('pending', 'queued')
    `;
    await tx.campaignRecipient.createMany({
      data: uniqueContacts.map((contact) => ({
        campaignId: args.campaignId,
        contactId: contact.id,
        token: newToken(),
        status: args.scheduleFor ? "pending" : "queued",
        tenantId: args.tenantId,
      })),
      skipDuplicates: true,
    });
    const updated = await tx.$executeRaw`
      UPDATE "Campaign" SET
        "audienceSnapshot" = ${JSON.stringify(exactSnapshot)}::jsonb,
        "recipientCount" = ${uniqueContacts.length},
        "scheduledFor" = ${args.scheduleFor ?? null},
        "status" = ${args.scheduleFor ? "scheduled" : "queued"},
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${args.campaignId}
        AND "tenantId" IS NOT DISTINCT FROM ${args.tenantId}
        AND "status" = 'approved'
    `;
    if (updated !== 1) throw new Error("Campaign approval changed before launch");
    const version = await nextVersionAndSnapshot(tx, args);
    return { count: uniqueContacts.length, version };
  });
}
