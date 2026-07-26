import crypto from "node:crypto";
import { basePrisma } from "./db";
import { isCampaignEditable, parseCampaignStatus } from "./campaignLifecycle";

export type CampaignDraftRecord = {
  id: string;
  tenantId: string | null;
  name: string;
  channel: string;
  subject: string | null;
  preheader: string | null;
  body: string;
  htmlBody: string | null;
  audience: string;
  segmentId: string | null;
  objective: string | null;
  offer: string | null;
  productId: string | null;
  landingPageUrl: string | null;
  primaryCtaLabel: string | null;
  primaryCtaUrl: string | null;
  internalNotes: string | null;
  budgetCents: number | null;
  targetLeadCount: number | null;
  targetRevenueCents: number | null;
  successMetric: string | null;
  ownerId: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  attributionWindowDays: number;
  status: string;
  updatedAt: Date;
};

export type CampaignDraftInput = Partial<Omit<CampaignDraftRecord, "id" | "tenantId" | "status" | "updatedAt">>;

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const nullable = (value: unknown) => text(value) || null;
const integer = (value: unknown) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

export function normaliseCampaignDraft(input: Record<string, unknown>): CampaignDraftInput {
  const channel = text(input.channel) || "email";
  if (!new Set(["email", "sms"]).has(channel)) throw new Error("Unsupported campaign channel");
  const attributionWindowDays = Math.max(1, Math.min(180, Number(input.attributionWindowDays) || 30));
  return {
    name: text(input.name) || "Untitled campaign",
    channel,
    subject: nullable(input.subject),
    preheader: nullable(input.preheader),
    body: text(input.body),
    htmlBody: nullable(input.htmlBody),
    audience: text(input.audience) || "Audience not selected",
    segmentId: nullable(input.segmentId),
    objective: nullable(input.objective),
    offer: nullable(input.offer),
    productId: nullable(input.productId),
    landingPageUrl: nullable(input.landingPageUrl),
    primaryCtaLabel: nullable(input.primaryCtaLabel),
    primaryCtaUrl: nullable(input.primaryCtaUrl),
    internalNotes: nullable(input.internalNotes),
    budgetCents: integer(input.budgetCents),
    targetLeadCount: integer(input.targetLeadCount),
    targetRevenueCents: integer(input.targetRevenueCents),
    successMetric: nullable(input.successMetric),
    ownerId: nullable(input.ownerId),
    utmSource: nullable(input.utmSource),
    utmMedium: nullable(input.utmMedium),
    utmCampaign: nullable(input.utmCampaign),
    utmContent: nullable(input.utmContent),
    utmTerm: nullable(input.utmTerm),
    attributionWindowDays,
  };
}

export async function createCampaignDraftRecord(args: {
  tenantId: string | null;
  userId: string;
  input?: Record<string, unknown>;
}) {
  const id = `cmp_${crypto.randomUUID()}`;
  const draft = normaliseCampaignDraft(args.input ?? {});
  await basePrisma.$executeRaw`
    INSERT INTO "Campaign" (
      "id", "tenantId", "name", "channel", "subject", "preheader", "body", "htmlBody",
      "audience", "segmentId", "objective", "offer", "productId", "landingPageUrl",
      "primaryCtaLabel", "primaryCtaUrl", "internalNotes", "budgetCents", "targetLeadCount",
      "targetRevenueCents", "successMetric", "ownerId", "utmSource", "utmMedium", "utmCampaign",
      "utmContent", "utmTerm", "attributionWindowDays", "status", "createdById", "createdAt", "updatedAt"
    ) VALUES (
      ${id}, ${args.tenantId}, ${draft.name}, ${draft.channel}, ${draft.subject}, ${draft.preheader},
      ${draft.body ?? ""}, ${draft.htmlBody}, ${draft.audience}, ${draft.segmentId}, ${draft.objective},
      ${draft.offer}, ${draft.productId}, ${draft.landingPageUrl}, ${draft.primaryCtaLabel},
      ${draft.primaryCtaUrl}, ${draft.internalNotes}, ${draft.budgetCents}, ${draft.targetLeadCount},
      ${draft.targetRevenueCents}, ${draft.successMetric}, ${draft.ownerId ?? args.userId}, ${draft.utmSource},
      ${draft.utmMedium}, ${draft.utmCampaign}, ${draft.utmContent}, ${draft.utmTerm}, ${draft.attributionWindowDays},
      'draft', ${args.userId}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `;
  return id;
}

export async function readCampaignDraftRecord(id: string, tenantId: string | null) {
  const rows = await basePrisma.$queryRaw<CampaignDraftRecord[]>`
    SELECT "id", "tenantId", "name", "channel", "subject", "preheader", "body", "htmlBody",
      "audience", "segmentId", "objective", "offer", "productId", "landingPageUrl",
      "primaryCtaLabel", "primaryCtaUrl", "internalNotes", "budgetCents", "targetLeadCount",
      "targetRevenueCents", "successMetric", "ownerId", "utmSource", "utmMedium", "utmCampaign",
      "utmContent", "utmTerm", "attributionWindowDays", "status", "updatedAt"
    FROM "Campaign"
    WHERE "id" = ${id} AND "tenantId" IS NOT DISTINCT FROM ${tenantId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function updateCampaignDraftRecord(args: {
  id: string;
  tenantId: string | null;
  input: Record<string, unknown>;
}) {
  const existing = await readCampaignDraftRecord(args.id, args.tenantId);
  if (!existing) throw new Error("Campaign not found");
  if (!isCampaignEditable(parseCampaignStatus(existing.status))) throw new Error("This campaign is locked and must be returned to draft before editing");
  const draft = normaliseCampaignDraft({ ...existing, ...args.input });
  await basePrisma.$executeRaw`
    UPDATE "Campaign" SET
      "name" = ${draft.name}, "channel" = ${draft.channel}, "subject" = ${draft.subject},
      "preheader" = ${draft.preheader}, "body" = ${draft.body ?? ""}, "htmlBody" = ${draft.htmlBody},
      "audience" = ${draft.audience}, "segmentId" = ${draft.segmentId}, "objective" = ${draft.objective},
      "offer" = ${draft.offer}, "productId" = ${draft.productId}, "landingPageUrl" = ${draft.landingPageUrl},
      "primaryCtaLabel" = ${draft.primaryCtaLabel}, "primaryCtaUrl" = ${draft.primaryCtaUrl},
      "internalNotes" = ${draft.internalNotes}, "budgetCents" = ${draft.budgetCents},
      "targetLeadCount" = ${draft.targetLeadCount}, "targetRevenueCents" = ${draft.targetRevenueCents},
      "successMetric" = ${draft.successMetric}, "ownerId" = ${draft.ownerId},
      "utmSource" = ${draft.utmSource}, "utmMedium" = ${draft.utmMedium}, "utmCampaign" = ${draft.utmCampaign},
      "utmContent" = ${draft.utmContent}, "utmTerm" = ${draft.utmTerm},
      "attributionWindowDays" = ${draft.attributionWindowDays}, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${args.id} AND "tenantId" IS NOT DISTINCT FROM ${args.tenantId}
  `;
}
