import { basePrisma } from "@/lib/db";
import { getActiveTenantId } from "@/lib/auth";
import { requirePermission } from "@/lib/permissions";
import { PageHeader } from "@/components/page-header";
import TemplateWorkspace from "@/components/marketing/TemplateWorkspace";

type TemplateRow = {
  id: string;
  name: string;
  subject: string;
  body: string;
  plainTextBody: string | null;
  category: string;
  status: string;
  version: number;
};

export default async function MarketingTemplatesPage() {
  await requirePermission("campaigns.view");
  const tenantId = await getActiveTenantId();
  const templates = await basePrisma.$queryRaw<TemplateRow[]>`
    SELECT "id", "name", "subject", "body", "plainTextBody", "category", "status", "version"
    FROM "EmailTemplate"
    WHERE "tenantId" IS NOT DISTINCT FROM ${tenantId}
    ORDER BY CASE WHEN "status" = 'archived' THEN 1 ELSE 0 END, "updatedAt" DESC, "name"
  `;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Templates"
        description="Create, preview, version and publish reusable email, SMS and operational content."
      />
      <TemplateWorkspace templates={templates} />
    </div>
  );
}
