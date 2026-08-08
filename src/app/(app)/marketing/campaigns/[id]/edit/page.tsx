import { notFound } from "next/navigation";
import CampaignDraftEditor from "@/components/marketing/CampaignDraftEditor";
import { getActiveTenantId } from "@/lib/auth";
import { requirePermission } from "@/lib/permissions";
import { readCampaignDraftRecord } from "@/lib/marketingCampaignDrafts";
import MarketingPageHeader from "@/components/marketing/MarketingPageHeader";

export default async function EditMarketingCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("campaigns.edit");
  const tenantId = await getActiveTenantId();
  const { id } = await params;
  const campaign = await readCampaignDraftRecord(id, tenantId);
  if (!campaign) notFound();

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <MarketingPageHeader title={campaign.name} description={`Persisted draft · ${campaign.status.replaceAll("_", " ")}`} />
      <CampaignDraftEditor initial={{
        id: campaign.id,
        name: campaign.name,
        channel: campaign.channel,
        subject: campaign.subject,
        preheader: campaign.preheader,
        body: campaign.body,
        htmlBody: campaign.htmlBody,
        audience: campaign.audience,
        segmentId: campaign.segmentId,
        objective: campaign.objective,
        offer: campaign.offer,
        landingPageUrl: campaign.landingPageUrl,
        primaryCtaLabel: campaign.primaryCtaLabel,
        primaryCtaUrl: campaign.primaryCtaUrl,
        internalNotes: campaign.internalNotes,
        budgetCents: campaign.budgetCents,
        targetLeadCount: campaign.targetLeadCount,
        targetRevenueCents: campaign.targetRevenueCents,
        successMetric: campaign.successMetric,
        utmSource: campaign.utmSource,
        utmMedium: campaign.utmMedium,
        utmCampaign: campaign.utmCampaign,
        utmContent: campaign.utmContent,
        utmTerm: campaign.utmTerm,
        attributionWindowDays: campaign.attributionWindowDays,
        status: campaign.status,
      }} />
    </div>
  );
}
