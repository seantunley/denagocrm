import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { requireVehicleReadAccess } from "@/lib/permissions";
import PrintActions from "@/components/PrintActions";
import PrintDocShell, { InfoBlock } from "@/components/print/PrintDocShell";
import { getCompanyProfile } from "@/lib/companyProfile";
import { getDocTemplate } from "@/lib/docTemplateStore";
import { computeWarranty, warrantyLabels } from "@/lib/warranty";
import { contactName, formatDate } from "@/lib/format";

export default async function WarrantyClaimPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tpl?: string }>;
}) {
  const { id } = await params;
  const { tpl: tplId } = await searchParams;
  await requireUser();
  const claim = await prisma.warrantyClaim.findUnique({
    where: { id },
    include: { vehicle: { include: { contact: true } } },
  });
  if (!claim) notFound();
  await requireVehicleReadAccess(claim.vehicleId);
  // The company this document is FROM. getCompanyProfile now inherits the
  // platform-set tenant brand when the tenant has not filled in its own profile.
  const company = await getCompanyProfile();
  const tpl = await getDocTemplate("warranty-claim", tplId);
  const w = computeWarranty(claim.vehicle);

  return (
    <>
      <PrintActions backHref="/warranty" backLabel="Back to warranty" />
      <PrintDocShell
        company={company}
        template={tpl}
        title="Warranty claim"
        number={`WC-${claim.id.slice(-6).toUpperCase()}`}
        meta={[`Claimed: ${formatDate(claim.claimedAt)}`, `Status: ${claim.status}`]}
        parties={{ left: "Customer · Date", right: "For Denago Cape Town · Date" }}
      >
        {tpl.sections.vehicle !== false && (
          <div className="grid grid-cols-2 gap-4 mb-6">
            <InfoBlock
              title="Customer"
              accent
              lines={[
                contactName(claim.vehicle.contact),
                claim.vehicle.contact.phone,
                claim.vehicle.contact.email,
              ]}
            />
            <InfoBlock
              title="Vehicle & warranty"
              lines={[
                claim.vehicle.model,
                claim.vehicle.vin ? `VIN: ${claim.vehicle.vin}` : null,
                claim.vehicle.purchaseDate
                  ? `Purchased: ${formatDate(claim.vehicle.purchaseDate)}`
                  : null,
                `Warranty: ${warrantyLabels[w.status]}${
                  w.expiryDate ? ` (until ${formatDate(w.expiryDate)})` : ""
                }`,
              ]}
            />
          </div>
        )}

        <div className="rounded-lg bg-slate-50 px-4 py-3 no-break">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">
            Reported fault
          </p>
          <p className="text-xs text-slate-700 whitespace-pre-wrap">{claim.description}</p>
        </div>

        {claim.resolution && (
          <div className="rounded-lg bg-slate-50 px-4 py-3 mt-4 no-break">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">
              Resolution
            </p>
            <p className="text-xs text-slate-700 whitespace-pre-wrap">
              {claim.resolution}
              {claim.resolvedAt ? ` (${formatDate(claim.resolvedAt)})` : ""}
            </p>
          </div>
        )}
      </PrintDocShell>
    </>
  );
}
