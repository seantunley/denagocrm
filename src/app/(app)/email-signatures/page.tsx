import { getActiveTenantId, isTenantOwner, requireUser } from "@/lib/auth";
import { basePrisma } from "@/lib/db";
import { getCompanyProfile } from "@/lib/companyProfile";
import { getSetting } from "@/lib/settings";
import { tenantOrigin } from "@/lib/tenantOrigin";
import { listActingTenantStaff, listActingTenantTeams } from "@/lib/tenantActor";
import { parseSignatureDesign, signatureCompanyFrom, SIGNATURE_DESIGN_KEY } from "@/lib/signature";
import { teamLineFor } from "@/lib/signaturePeople";
import { senderSignatureDetails } from "@/lib/signatureSender";
import { PageHeader } from "@/components/page-header";
import EmailSignatureSection from "@/components/EmailSignatureSection";
import EmailSignatureDetails, { type SignaturePerson } from "@/components/EmailSignatureDetails";

export const dynamic = "force-dynamic";

const PERSON_SELECT = {
  id: true, name: true, email: true, mobile: true, jobTitle: true, signatureHtml: true, avatarRef: true, signaturePhoto: true,
  signatureQualifications: true, signatureDirectLine: true, signatureWhatsapp: true, signatureBookingUrl: true, signatureHours: true,
} as const;

type PersonRow = {
  id: string; name: string; email: string; mobile: string | null; jobTitle: string | null; signatureHtml: string | null;
  avatarRef: string | null; signaturePhoto: boolean; signatureQualifications: string | null; signatureDirectLine: string | null;
  signatureWhatsapp: string | null; signatureBookingUrl: string | null; signatureHours: string | null;
};

/**
 * The Email signatures pack's own page (Sean, 2026-11-20: "I think it needs its own module now"). Reached only while the
 * pack is on — the route guard holds every path in its routePrefixes (lib/modules/registry.ts). Everyone edits their own
 * signature in the visual editor; the workspace's owner also edits the design, the rules (locked details, a line per
 * team, short replies) and every team member's signature, and reaches the banners.
 */
export default async function EmailSignaturesPage() {
  const user = await requireUser();
  const isOwner = await isTenantOwner();
  const tenantId = await getActiveTenantId();
  // The previews render what the send path renders: the same design, company and glyph URLs.
  const design = parseSignatureDesign(await getSetting(SIGNATURE_DESIGN_KEY));
  const company = signatureCompanyFrom(await getCompanyProfile(), await tenantOrigin(tenantId), design);
  const [details, me, teams, staffIds] = await Promise.all([
    senderSignatureDetails(tenantId, user.id, design, company.assetBase).catch(() => ({})),
    basePrisma.user.findUnique({ where: { id: user.id }, select: PERSON_SELECT }),
    isOwner ? listActingTenantTeams() : Promise.resolve([]),
    isOwner ? listActingTenantStaff() : Promise.resolve([]),
  ]);
  if (!me || !tenantId) return null;
  // Everyone else in THIS workspace (listActingTenantStaff names the workspace), for the owner to set their details.
  const others = isOwner && staffIds.length
    ? await basePrisma.user.findMany({
        where: { id: { in: staffIds.map((s) => s.id).filter((id) => id !== user.id) }, memberships: { some: { tenantId } } },
        select: PERSON_SELECT,
        orderBy: { name: "asc" },
      })
    : [];
  // Each person's team line, for their preview.
  const memberships = design.teams?.length
    ? await basePrisma.teamMember.findMany({
        where: { tenantId, userId: { in: [me.id, ...others.map((o) => o.id)] }, team: { active: true, deletedAt: null } },
        select: { userId: true, teamId: true },
      })
    : [];
  const asPerson = (u: PersonRow): SignaturePerson => ({
    id: u.id, name: u.name, email: u.email, mobile: u.mobile, jobTitle: u.jobTitle,
    qualifications: u.signatureQualifications, directLine: u.signatureDirectLine, whatsapp: u.signatureWhatsapp,
    bookingUrl: u.signatureBookingUrl, hours: u.signatureHours, photo: u.signaturePhoto, hasPhoto: Boolean(u.avatarRef),
    teamLine: teamLineFor(design.teams ?? [], memberships.filter((m) => m.userId === u.id).map((m) => m.teamId)),
    customHtmlInUse: Boolean(u.signatureHtml?.trim()),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Email signatures"
        description={isOwner
          ? "The signature on everyone's emails: each person's details, the workspace design, team lines and the banners under it."
          : "The signature on your emails, built from the workspace design and your own details."}
      />
      <EmailSignatureDetails
        me={asPerson(me)}
        locked={design.locked ?? []}
        isOwner={isOwner}
        company={company}
        teams={teams}
        teamLines={design.teams ?? []}
        shortReplies={design.shortReplies === true}
        staff={others.map(asPerson)}
      />
      {/* The design is the owner's; anyone else sees this only to clear an old HTML signature of their own. */}
      {(isOwner || Boolean(me.signatureHtml?.trim())) && (
        <section className="card space-y-3 p-5">
          <h2 className="text-base font-semibold">{isOwner ? "Workspace design" : "Your own HTML signature"}</h2>
          <EmailSignatureSection
            user={me}
            company={company}
            design={design}
            canEditDesign={isOwner}
            bannersHref={isOwner ? "/settings/signature-banners" : null}
            details={details}
            designPreview={isOwner}
          />
        </section>
      )}
    </div>
  );
}
