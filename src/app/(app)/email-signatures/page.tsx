import { getActiveTenantId, isTenantOwner, requireUser } from "@/lib/auth";
import { basePrisma } from "@/lib/db";
import { getCompanyProfile } from "@/lib/companyProfile";
import { getSetting } from "@/lib/settings";
import { tenantOrigin } from "@/lib/tenantOrigin";
import { listActingTenantStaff, listActingTenantTeams } from "@/lib/tenantActor";
import { parseSignatureDesign, signatureCompanyFrom, SIGNATURE_DESIGN_KEY } from "@/lib/signature";
import { senderSignatureDetails } from "@/lib/signatureSender";
import { PageHeader } from "@/components/page-header";
import EmailSignatureSection from "@/components/EmailSignatureSection";
import EmailSignatureDetails, { type PersonDetails } from "@/components/EmailSignatureDetails";

export const dynamic = "force-dynamic";

const DETAIL_SELECT = {
  id: true, name: true, email: true, avatarRef: true, signaturePhoto: true, signatureQualifications: true,
  signatureDirectLine: true, signatureWhatsapp: true, signatureBookingUrl: true, signatureHours: true,
} as const;

const asDetails = (u: {
  avatarRef: string | null; signaturePhoto: boolean; signatureQualifications: string | null; signatureDirectLine: string | null;
  signatureWhatsapp: string | null; signatureBookingUrl: string | null; signatureHours: string | null;
}): PersonDetails => ({
  qualifications: u.signatureQualifications,
  directLine: u.signatureDirectLine,
  whatsapp: u.signatureWhatsapp,
  bookingUrl: u.signatureBookingUrl,
  hours: u.signatureHours,
  photo: u.signaturePhoto,
  hasPhoto: Boolean(u.avatarRef),
});

/**
 * The Email signatures pack's own page (Sean, 2026-11-20: "I think it needs its own module now"). Reached only while the
 * pack is on — the route guard holds every path in its routePrefixes (lib/modules/registry.ts). Everyone sees their own
 * signature and sets their own details; the workspace's owner also edits the design, the rules (locked details, a line
 * per team, short replies), every team member's details, and reaches the banners.
 */
export default async function EmailSignaturesPage() {
  const user = await requireUser();
  const isOwner = await isTenantOwner();
  const tenantId = await getActiveTenantId();
  // The preview renders what the send path renders: the same design, company, glyph URLs and the person's own details.
  const design = parseSignatureDesign(await getSetting(SIGNATURE_DESIGN_KEY));
  const company = signatureCompanyFrom(await getCompanyProfile(), await tenantOrigin(tenantId), design);
  const [details, me, teams, staffIds] = await Promise.all([
    senderSignatureDetails(tenantId, user.id, design, company.assetBase).catch(() => ({})),
    basePrisma.user.findUnique({ where: { id: user.id }, select: DETAIL_SELECT }),
    isOwner ? listActingTenantTeams() : Promise.resolve([]),
    isOwner ? listActingTenantStaff() : Promise.resolve([]),
  ]);
  // Everyone else in THIS workspace (listActingTenantStaff names the workspace), for the owner to set their details.
  const others = isOwner && tenantId && staffIds.length
    ? await basePrisma.user.findMany({
        where: { id: { in: staffIds.map((s) => s.id).filter((id) => id !== user.id) }, memberships: { some: { tenantId } } },
        select: DETAIL_SELECT,
        orderBy: { name: "asc" },
      })
    : [];
  return (
    <div className="space-y-4">
      <PageHeader
        title="Email signatures"
        description={isOwner
          ? "The signature on everyone's emails: the workspace design, each person's own details, team lines and the banners under it."
          : "The signature on your emails, built from the workspace design and your own details."}
      />
      <div className="card max-w-3xl p-5">
        <EmailSignatureSection
          user={user}
          company={company}
          design={design}
          canEditDesign={isOwner}
          bannersHref={isOwner ? "/settings/signature-banners" : null}
          details={details}
        />
      </div>
      {me && (
        <EmailSignatureDetails
          me={asDetails(me)}
          locked={design.locked ?? []}
          isOwner={isOwner}
          teams={teams}
          teamLines={design.teams ?? []}
          shortReplies={design.shortReplies === true}
          staff={others.map((u) => ({ id: u.id, name: u.name, email: u.email, ...asDetails(u) }))}
        />
      )}
    </div>
  );
}
