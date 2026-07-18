import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireJobCardReadAccess } from "@/lib/permissions";
import PrintActions from "@/components/PrintActions";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { getDocTemplate } from "@/lib/docTemplateStore";
import { stageMeta } from "@/lib/workshop-constants";

export default async function JobCardPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tpl?: string; photos?: string }>;
}) {
  const { id } = await params;
  await requireJobCardReadAccess(id);
  const { tpl: tplId, photos } = await searchParams;
  const showPhotos = photos === "1";
  const jobCard = await prisma.jobCard.findUnique({
    where: { id },
    include: {
      vehicle: true,
      contact: true,
      items: true,
      serviceRecord: { include: { performedBy: true } },
      documents: {
        where: { deletedAt: null, tag: { in: ["checkin-photo", "checkout-photo"] } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!jobCard) notFound();
  const tpl = await getDocTemplate("jobcard", tplId);
  const conditionPhotos = jobCard.documents;
  const photoHref = showPhotos
    ? `/jobcards/${id}/print${tplId ? `?tpl=${tplId}` : ""}`
    : `/jobcards/${id}/print?photos=1${tplId ? `&tpl=${tplId}` : ""}`;

  const partsTotal = jobCard.items
    .filter((i) => i.kind === "part")
    .reduce((s, i) => s + i.qty * i.unitPriceCents, 0);
  const labourTotal = jobCard.items
    .filter((i) => i.kind === "labour")
    .reduce((s, i) => s + i.qty * i.unitPriceCents, 0);

  const address = [
    jobCard.contact.address,
    jobCard.contact.suburb,
    jobCard.contact.city,
    jobCard.contact.province,
    jobCard.contact.postalCode,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <>
      <PrintActions backHref={`/jobcards/${jobCard.id}`} backLabel="Back to job card" />
      {conditionPhotos.length > 0 && (
        <div className="print:hidden mx-auto max-w-3xl px-6 pt-2 text-sm">
          <Link
            href={photoHref}
            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              showPhotos
                ? "border-orange-500/40 bg-orange-500/10 text-orange-300"
                : "border-slate-700 text-slate-300 hover:border-slate-500"
            }`}
          >
            {showPhotos ? "✓ Condition photos included" : "📷 Include condition photos"}
            <span className="text-slate-500">({conditionPhotos.length})</span>
          </Link>
          <p className="mt-1 text-[11px] text-slate-500">Off by default — toggle before printing to append the check-in / check-out photos.</p>
        </div>
      )}
      <style>{`
        @page { margin: 12mm; }
        @media print { * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; } }
      `}</style>

      <div className="max-w-3xl mx-auto px-6 py-8 print:p-0 text-sm">
        {/* Brand banner */}
        <div className="flex items-center justify-between rounded-xl bg-[#020617] px-7 py-5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={tpl.logoUrl ?? "/branding/denago-logo-email.png"}
            alt="Denago Cape Town EV"
            className="h-11 w-auto object-contain"
          />
          <div className="text-right">
            <p className="text-2xl font-semibold tracking-[-0.035em] tracking-widest text-white">JOB CARD</p>
            <p className="text-lg font-bold text-orange-500">#{jobCard.number}</p>
            <p className="text-xs text-slate-400">{stageMeta(jobCard.status).label}</p>
          </div>
        </div>
        {tpl.sections.footer !== false && (
          <div className="flex justify-between items-center px-1 py-3 text-xs text-slate-500">
            <span>{tpl.footerLines[0] ?? ""}</span>
            <span>{tpl.footerLines[1] ?? ""}</span>
          </div>
        )}

        {/* Meta */}
        <div className="grid grid-cols-2 gap-6 py-5">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1.5">
              Customer
            </p>
            <p className="font-semibold">{contactName(jobCard.contact)}</p>
            {jobCard.contact.phone && <p>{jobCard.contact.phone}</p>}
            {jobCard.contact.email && <p>{jobCard.contact.email}</p>}
            {address && <p className="text-slate-600">{address}</p>}
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1.5">
              Vehicle
            </p>
            <p className="font-semibold">
              {jobCard.vehicle.model}
              {jobCard.vehicle.color ? ` — ${jobCard.vehicle.color}` : ""}
            </p>
            {jobCard.vehicle.vin && <p>VIN / Serial: {jobCard.vehicle.vin}</p>}
            {jobCard.vehicle.regNumber && <p>Reg: {jobCard.vehicle.regNumber}</p>}
            <p className="text-slate-600">
              Opened {formatDate(jobCard.openedAt)}
              {jobCard.kmIn != null ? ` · ${jobCard.kmIn.toLocaleString()} km in` : ""}
              {jobCard.completedAt ? ` · Completed ${formatDate(jobCard.completedAt)}` : ""}
            </p>
          </div>
        </div>

        {/* Work requested */}
        <div className="mb-5">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1.5">
            Work requested
          </p>
          <p className="whitespace-pre-wrap border border-slate-300 rounded p-3">
            {jobCard.description}
          </p>
        </div>

        {/* Items */}
        <table className="w-full border-collapse mb-5">
          <thead>
            <tr className="border-b-2 border-slate-900 text-left">
              <th className="py-1.5 pr-2 text-xs uppercase tracking-wide">Type</th>
              <th className="py-1.5 pr-2 text-xs uppercase tracking-wide">Description</th>
              <th className="py-1.5 pr-2 text-xs uppercase tracking-wide text-right">Qty</th>
              <th className="py-1.5 pr-2 text-xs uppercase tracking-wide text-right">Unit price</th>
              <th className="py-1.5 text-xs uppercase tracking-wide text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {jobCard.items.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-center text-slate-500">
                  No parts or labour recorded.
                </td>
              </tr>
            )}
            {jobCard.items.map((i) => (
              <tr key={i.id} className="border-b border-slate-200">
                <td className="py-1.5 pr-2 capitalize">{i.kind}</td>
                <td className="py-1.5 pr-2">{i.description}</td>
                <td className="py-1.5 pr-2 text-right">{i.qty}</td>
                <td className="py-1.5 pr-2 text-right">{formatZAR(i.unitPriceCents)}</td>
                <td className="py-1.5 text-right">{formatZAR(Math.round(i.qty * i.unitPriceCents))}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="flex justify-end mb-6">
          <div className="w-64 space-y-1">
            <div className="flex justify-between">
              <span className="text-slate-600">Parts</span>
              <span>{formatZAR(Math.round(partsTotal))}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-600">Labour</span>
              <span>{formatZAR(Math.round(labourTotal))}</span>
            </div>
            <div className="flex justify-between border-t-2 border-slate-900 pt-1 font-bold">
              <span>Total</span>
              <span>{formatZAR(Math.round(partsTotal + labourTotal))}</span>
            </div>
          </div>
        </div>

        {/* Service outcome */}
        {jobCard.serviceRecord && (
          <div className="mb-6">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1.5">
              Service record
            </p>
            <p>
              {jobCard.serviceRecord.summary}
              {jobCard.serviceRecord.km != null
                ? ` · at ${jobCard.serviceRecord.km.toLocaleString()} km`
                : ""}
              {jobCard.serviceRecord.performedBy
                ? ` · Technician: ${jobCard.serviceRecord.performedBy.name}`
                : ""}
            </p>
            {jobCard.serviceRecord.details && (
              <p className="text-slate-600 whitespace-pre-wrap">{jobCard.serviceRecord.details}</p>
            )}
            <p className="text-slate-600">
              Next service due:{" "}
              {jobCard.serviceRecord.nextDueDate
                ? formatDate(jobCard.serviceRecord.nextDueDate)
                : "—"}
              {jobCard.serviceRecord.nextDueKm != null
                ? ` / ${jobCard.serviceRecord.nextDueKm.toLocaleString()} km`
                : ""}
            </p>
          </div>
        )}

        {jobCard.notes && (
          <div className="mb-6">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1.5">Notes</p>
            <p className="whitespace-pre-wrap text-slate-600">{jobCard.notes}</p>
          </div>
        )}

        {/* Condition photos — opt-in via ?photos=1 (marked-up version when present) */}
        {showPhotos && conditionPhotos.length > 0 && (
          <div className="mb-6" style={{ breakInside: "avoid" }}>
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1.5">
              Condition photos
            </p>
            <div className="grid grid-cols-2 gap-3">
              {conditionPhotos.map((d) => (
                <figure key={d.id} style={{ breakInside: "avoid" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/jobcard-photo/${d.id}${d.annotatedStoredName ? "?v=annotated" : ""}`}
                    alt={d.fileName}
                    className="w-full rounded-lg border border-slate-300 object-contain"
                  />
                  <figcaption className="mt-0.5 text-[10px] text-slate-500">
                    {d.tag === "checkout-photo" ? "Check-out" : "Check-in"}
                    {d.annotatedStoredName ? " · marked up" : ""}
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        )}

        {/* Signatures */}
        {jobCard.signedAt ? (
          <div className="pt-8">
            {jobCard.signatureRef?.startsWith("http") && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={jobCard.signatureRef} alt="Signature" className="h-16 w-auto mb-1" />
            )}
            <div className="border-t border-slate-900 pt-1.5 max-w-md">
              <p className="text-xs text-slate-600">
                Signed electronically by <b>{jobCard.signedByName}</b> on{" "}
                {formatDate(jobCard.signedAt)}
                {jobCard.signerIp ? ` · IP ${jobCard.signerIp}` : ""} · ECT Act, 2002
              </p>
            </div>
          </div>
        ) : tpl.sections.signatures === false ? null : (
          <div
            className={
              tpl.signature.position === "strip"
                ? "grid grid-cols-1 gap-8 pt-10"
                : "grid grid-cols-2 gap-10 pt-10"
            }
          >
            {(tpl.signature.position === "right-left"
              ? ["Customer signature · Date", "Technician signature · Date"]
              : ["Technician signature · Date", "Customer signature · Date"]
            ).map((labelText) => (
              <div key={labelText}>
                <div className="border-t border-slate-900 pt-1.5">
                  <p className="text-xs text-slate-600">{labelText}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="text-[10px] text-slate-400 mt-8 text-center">
          Denago Cape Town · Authorized Denago EV Dealer · Job card #{jobCard.number} · Generated{" "}
          {formatDate(new Date())}
        </p>
      </div>
    </>
  );
}
