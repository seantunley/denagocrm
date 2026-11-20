import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireVehicleReadAccess } from "@/lib/permissions";
import { requireModuleEnabled } from "@/lib/modules/enabled";
import PrintActions from "@/components/PrintActions";
import PrintDocShell, { InfoBlock } from "@/components/print/PrintDocShell";
import { getCompanyProfile } from "@/lib/companyProfile";
import { getRegionalSettings } from "@/lib/settings";
import { getDocTemplate } from "@/lib/docTemplateStore";
import { computeWarranty } from "@/lib/warranty";
import { contactName, formatDate } from "@/lib/format";
import { coverRemaining, OWNERSHIP_REASON_LABELS, OWNERSHIP_WARRANTY_LABELS, parseOwnershipWarranty, type OwnershipReason } from "@/lib/vehicleTransferRules";

/**
 * VEHICLE TRANSFER CERTIFICATE (warranty-transfer-brief.md, PR 3): the vehicle, its VIN, the new owner, the transfer
 * date, the odometer, the warranty's expiry and the cover remaining on that date — under the workspace's name and logo.
 * Printed (or saved as PDF) like the warranty claim it sits beside. It names only the NEW owner: it is handed to them.
 *
 * ?o=<ownership id> prints that transfer; without it, the latest transfer that wasn't undone.
 */
export default async function TransferCertificatePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ o?: string }>;
}) {
  const { id } = await params;
  const { o } = await searchParams;
  await requireModuleEnabled("automotive");
  await requireVehicleReadAccess(id);
  const vehicle = await prisma.vehicle.findUnique({ where: { id }, select: { id: true, tenantId: true, model: true, vin: true, regNumber: true, color: true, purchaseDate: true, warrantyMonths: true } });
  if (!vehicle?.tenantId) notFound();
  const transfer = await prisma.vehicleOwnership.findFirst({
    where: { tenantId: vehicle.tenantId, vehicleId: id, reversedAt: null, NOT: { reason: "registered" }, ...(o ? { id: o } : {}) },
    orderBy: { ownedFrom: "desc" },
    include: { contact: true },
  });
  if (!transfer) notFound();
  // The workspace's own branding, as on its warranty documents.
  const [company, regional, tpl] = await Promise.all([getCompanyProfile(), getRegionalSettings(), getDocTemplate("warranty-claim")]);
  const w = computeWarranty(vehicle);
  const reason = (transfer.reason in OWNERSHIP_REASON_LABELS ? transfer.reason : "other") as OwnershipReason;
  const warranty = parseOwnershipWarranty(transfer.warranty);

  return (
    <>
      <PrintActions backHref={`/vehicles/${id}#ownership`} backLabel="Back to the vehicle" />
      <PrintDocShell
        company={company}
        template={tpl}
        title="Vehicle transfer certificate"
        number={`VT-${transfer.id.slice(-6).toUpperCase()}`}
        meta={[`Transferred: ${formatDate(transfer.ownedFrom, regional)}`, OWNERSHIP_REASON_LABELS[reason]]}
        parties={{ left: "New owner · Date", right: `For ${company.name} · Date` }}
      >
        <div className="grid grid-cols-2 gap-4 mb-6">
          <InfoBlock
            title="New owner"
            accent
            lines={transfer.contact ? [contactName(transfer.contact), transfer.contact.phone, transfer.contact.email] : ["(no longer on record)"]}
          />
          <InfoBlock
            title="Vehicle"
            lines={[
              `${vehicle.model}${vehicle.color ? ` · ${vehicle.color}` : ""}`,
              vehicle.vin ? `VIN: ${vehicle.vin}` : "VIN not recorded",
              vehicle.regNumber ? `Registration: ${vehicle.regNumber}` : null,
              transfer.odometerKm != null ? `Odometer at handover: ${transfer.odometerKm.toLocaleString()} km` : null,
            ]}
          />
        </div>
        <div className="rounded-lg bg-slate-50 px-4 py-3 no-break">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">Warranty</p>
          <p className="text-xs text-slate-700">
            {w.expiryDate ? `Expires ${formatDate(w.expiryDate, regional)}. ` : "No warranty on record. "}
            {w.expiryDate ? `${coverRemaining(vehicle, transfer.ownedFrom)} on the transfer date.` : ""}
          </p>
          <p className="text-xs text-slate-700 mt-1">
            {warranty === "carried"
              ? "The remaining warranty transferred to the new owner with the vehicle."
              : warranty === "pending"
                ? "The warranty transfer to the new owner is awaiting approval."
                : `${OWNERSHIP_WARRANTY_LABELS.not_carried} to the new owner.`}
          </p>
        </div>
        <p className="mt-4 text-xs text-slate-500">
          The vehicle&apos;s service and warranty history stays with the vehicle. This certificate records its transfer to the
          owner named above on {formatDate(transfer.ownedFrom, regional)}.
        </p>
      </PrintDocShell>
    </>
  );
}
