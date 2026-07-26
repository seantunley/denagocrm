import { basePrisma } from "./db";

export function marketingEfficiency(args: { spendCents: number; attributedRevenueCents: number; leads: number }) {
  return {
    roas: args.spendCents > 0 ? Math.round((args.attributedRevenueCents / args.spendCents) * 100) / 100 : null,
    costPerLeadCents: args.leads > 0 ? Math.round(args.spendCents / args.leads) : null,
  };
}

export async function loadMarketingOverview(args: { tenantId: string | null; from: Date; to: Date }) {
  const [campaignSummary] = await basePrisma.$queryRaw<Array<{
    campaigns: bigint; sent: bigint; delivered: bigint; opened: bigint; clicked: bigint;
    conversions: bigint; revenueCents: bigint; spendCents: bigint;
  }>>`
    SELECT COUNT(*)::bigint AS "campaigns",
      COALESCE(SUM("sentCount"), 0)::bigint AS "sent",
      COALESCE(SUM("deliveredCount"), 0)::bigint AS "delivered",
      COALESCE(SUM("openCount"), 0)::bigint AS "opened",
      COALESCE(SUM("clickCount"), 0)::bigint AS "clicked",
      COALESCE(SUM("conversionCount"), 0)::bigint AS "conversions",
      COALESCE(SUM("attributedRevenueCents"), 0)::bigint AS "revenueCents",
      COALESCE(SUM("budgetCents"), 0)::bigint AS "spendCents"
    FROM "Campaign"
    WHERE "tenantId" IS NOT DISTINCT FROM ${args.tenantId}
      AND "createdAt" >= ${args.from} AND "createdAt" < ${args.to}
      AND "status" <> 'archived'
  `;
  const [conversionSummary] = await basePrisma.$queryRaw<Array<{ leads: bigint; quotes: bigint; sales: bigint; revenueCents: bigint }>>`
    SELECT
      COUNT(*) FILTER (WHERE "conversionType" = 'lead_created')::bigint AS "leads",
      COUNT(*) FILTER (WHERE "conversionType" IN ('quote_sent', 'quote_accepted'))::bigint AS "quotes",
      COUNT(*) FILTER (WHERE "conversionType" = 'sale_won')::bigint AS "sales",
      COALESCE(SUM("valueCents") FILTER (WHERE "conversionType" = 'sale_won'), 0)::bigint AS "revenueCents"
    FROM "CampaignConversion"
    WHERE "tenantId" IS NOT DISTINCT FROM ${args.tenantId}
      AND "occurredAt" >= ${args.from} AND "occurredAt" < ${args.to}
  `;
  const [surveySummary] = await basePrisma.$queryRaw<Array<{ distributions: bigint; sent: bigint; completed: bigint; unresolved: bigint }>>`
    SELECT
      (SELECT COUNT(*) FROM "SurveyDistribution" d WHERE d."tenantId" IS NOT DISTINCT FROM ${args.tenantId} AND d."createdAt" >= ${args.from} AND d."createdAt" < ${args.to})::bigint AS "distributions",
      (SELECT COALESCE(SUM(d."sentCount"), 0) FROM "SurveyDistribution" d WHERE d."tenantId" IS NOT DISTINCT FROM ${args.tenantId} AND d."createdAt" >= ${args.from} AND d."createdAt" < ${args.to})::bigint AS "sent",
      (SELECT COALESCE(SUM(d."completedCount"), 0) FROM "SurveyDistribution" d WHERE d."tenantId" IS NOT DISTINCT FROM ${args.tenantId} AND d."createdAt" >= ${args.from} AND d."createdAt" < ${args.to})::bigint AS "completed",
      (SELECT COUNT(*) FROM "SurveyFollowUp" f WHERE f."tenantId" IS NOT DISTINCT FROM ${args.tenantId} AND f."status" <> 'resolved')::bigint AS "unresolved"
  `;

  const topCampaigns = await basePrisma.$queryRaw<Array<{
    id: string; name: string; channel: string; status: string; sentCount: number; openCount: number;
    clickCount: number; conversionCount: number; attributedRevenueCents: number; budgetCents: number | null;
  }>>`
    SELECT "id", "name", "channel", "status", "sentCount", "openCount", "clickCount",
      "conversionCount", "attributedRevenueCents", "budgetCents"
    FROM "Campaign"
    WHERE "tenantId" IS NOT DISTINCT FROM ${args.tenantId}
      AND "createdAt" >= ${args.from} AND "createdAt" < ${args.to}
      AND "status" <> 'archived'
    ORDER BY "attributedRevenueCents" DESC, "conversionCount" DESC, "clickCount" DESC
    LIMIT 10
  `;

  const workQueues = await basePrisma.$queryRaw<Array<{ kind: string; count: bigint }>>`
    SELECT 'campaign_review' AS "kind", COUNT(*)::bigint AS "count" FROM "Campaign"
      WHERE "tenantId" IS NOT DISTINCT FROM ${args.tenantId} AND "status" = 'in_review'
    UNION ALL
    SELECT 'campaign_errors', COUNT(*)::bigint FROM "Campaign"
      WHERE "tenantId" IS NOT DISTINCT FROM ${args.tenantId} AND "status" IN ('failed', 'completed_with_errors')
    UNION ALL
    SELECT 'survey_review', COUNT(*)::bigint FROM "Survey"
      WHERE "tenantId" IS NOT DISTINCT FROM ${args.tenantId} AND "status" = 'in_review' AND "deletedAt" IS NULL
    UNION ALL
    SELECT 'survey_follow_up', COUNT(*)::bigint FROM "SurveyFollowUp"
      WHERE "tenantId" IS NOT DISTINCT FROM ${args.tenantId} AND "status" <> 'resolved'
  `;

  const calendar = await basePrisma.$queryRaw<Array<{
    id: string; kind: string; title: string; status: string; startsAt: Date; href: string;
  }>>`
    SELECT c."id", 'campaign' AS "kind", c."name" AS "title", c."status", c."scheduledFor" AS "startsAt",
      '/marketing/campaigns/' || c."id" AS "href"
    FROM "Campaign" c
    WHERE c."tenantId" IS NOT DISTINCT FROM ${args.tenantId}
      AND c."scheduledFor" >= ${args.from} AND c."scheduledFor" < ${args.to}
    UNION ALL
    SELECT d."id", 'survey' AS "kind", d."name" AS "title", d."status", d."scheduledFor" AS "startsAt",
      '/marketing/surveys/distributions/' || d."id" AS "href"
    FROM "SurveyDistribution" d
    WHERE d."tenantId" IS NOT DISTINCT FROM ${args.tenantId}
      AND d."scheduledFor" >= ${args.from} AND d."scheduledFor" < ${args.to}
    ORDER BY "startsAt"
  `;

  const campaigns = {
    campaigns: Number(campaignSummary?.campaigns ?? 0),
    sent: Number(campaignSummary?.sent ?? 0),
    delivered: Number(campaignSummary?.delivered ?? 0),
    opened: Number(campaignSummary?.opened ?? 0),
    clicked: Number(campaignSummary?.clicked ?? 0),
    conversions: Number(conversionSummary?.leads ?? campaignSummary?.conversions ?? 0),
    quotes: Number(conversionSummary?.quotes ?? 0),
    sales: Number(conversionSummary?.sales ?? 0),
    attributedRevenueCents: Number(conversionSummary?.revenueCents ?? campaignSummary?.revenueCents ?? 0),
    spendCents: Number(campaignSummary?.spendCents ?? 0),
  };
  const surveys = {
    distributions: Number(surveySummary?.distributions ?? 0),
    sent: Number(surveySummary?.sent ?? 0),
    completed: Number(surveySummary?.completed ?? 0),
    unresolved: Number(surveySummary?.unresolved ?? 0),
  };
  return {
    campaigns,
    surveys,
    efficiency: marketingEfficiency({ spendCents: campaigns.spendCents, attributedRevenueCents: campaigns.attributedRevenueCents, leads: campaigns.conversions }),
    topCampaigns,
    workQueues: Object.fromEntries(workQueues.map((row) => [row.kind, Number(row.count)])),
    calendar,
  };
}
