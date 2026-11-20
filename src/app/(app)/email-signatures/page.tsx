import { getActiveTenantId, isTenantOwner, requireUser } from "@/lib/auth";
import { getCompanyProfile } from "@/lib/companyProfile";
import { getSetting } from "@/lib/settings";
import { tenantOrigin } from "@/lib/tenantOrigin";
import { parseSignatureDesign, signatureCompanyFrom, SIGNATURE_DESIGN_KEY } from "@/lib/signature";
import { PageHeader } from "@/components/page-header";
import EmailSignatureSection from "@/components/EmailSignatureSection";

export const dynamic = "force-dynamic";

/**
 * The Email signatures pack's own page (Sean, 2026-11-20: "I think it needs its own module now"). Reached only while the
 * pack is on — the route guard holds every path in its routePrefixes (lib/modules/registry.ts). Everyone sees their own
 * signature; the workspace's owner also edits the design and reaches the banners.
 */
export default async function EmailSignaturesPage() {
  const user = await requireUser();
  const isOwner = await isTenantOwner();
  // The preview renders what the send path renders: the same design, company and glyph URLs.
  const design = parseSignatureDesign(await getSetting(SIGNATURE_DESIGN_KEY));
  const company = signatureCompanyFrom(await getCompanyProfile(), await tenantOrigin(await getActiveTenantId()), design);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Email signatures"
        description={isOwner
          ? "The signature on everyone's emails: the workspace design, each person's own details and the banners under it."
          : "The signature on your emails, built from the workspace design and your own details."}
      />
      <div className="card max-w-3xl p-5">
        <EmailSignatureSection
          user={user}
          company={company}
          design={design}
          canEditDesign={isOwner}
          bannersHref={isOwner ? "/settings/signature-banners" : null}
        />
      </div>
    </div>
  );
}
