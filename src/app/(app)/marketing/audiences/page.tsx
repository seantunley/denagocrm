import { basePrisma } from "@/lib/db";
import { getActiveTenantId } from "@/lib/auth";
import { requirePermission } from "@/lib/permissions";
import { PageHeader } from "@/components/page-header";
import AudienceWorkspace from "@/components/marketing/AudienceWorkspace";

type AudienceRow = {
  id: string;
  name: string;
  ruleTree: unknown;
  status: string;
  lastCalculatedCount: number;
  lastCalculatedAt: Date | null;
  updatedAt: Date;
  explanation: string | null;
  version: number | null;
};

export default async function MarketingAudiencesPage() {
  await requirePermission("campaigns.view");
  const tenantId = await getActiveTenantId();

  // Every lookup is explicitly tenant-scoped. The browser choices are only UX;
  // Server Actions validate any referenced tag/product ids again before preview,
  // persistence or campaign evaluation.
  const [audiences, tags, products] = await Promise.all([
    basePrisma.$queryRaw<AudienceRow[]>`
      SELECT s."id", s."name", s."ruleTree", COALESCE(s."status", 'active') AS "status",
        COALESCE(s."lastCalculatedCount", 0) AS "lastCalculatedCount",
        s."lastCalculatedAt", s."updatedAt",
        latest."explanation", latest."version"
      FROM "Segment" s
      LEFT JOIN LATERAL (
        SELECT v."explanation", v."version"
        FROM "MarketingAudienceVersion" v
        WHERE v."segmentId" = s."id"
          AND v."tenantId" IS NOT DISTINCT FROM ${tenantId}
        ORDER BY v."version" DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE s."tenantId" IS NOT DISTINCT FROM ${tenantId}
      ORDER BY CASE WHEN COALESCE(s."status", 'active') = 'archived' THEN 1 ELSE 0 END,
        s."updatedAt" DESC
    `,
    tenantId
      ? basePrisma.tag.findMany({
          where: { tenantId },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
        })
      : Promise.resolve([]),
    basePrisma.product.findMany({
      where: { tenantId, active: true, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Audiences"
        description="Build reusable, consent-safe customer groups with live reach and version history."
      />
      <AudienceWorkspace
        audiences={audiences.map((audience) => ({
          ...audience,
          lastCalculatedAt: audience.lastCalculatedAt?.toISOString() ?? null,
          updatedAt: audience.updatedAt.toISOString(),
        }))}
        tags={tags}
        products={products}
      />
    </div>
  );
}
