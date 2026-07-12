import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireJobCardReadAccess } from "@/lib/permissions";
import PrintActions from "@/components/PrintActions";
import PrintDocShell, { ItemsTable, InfoBlock } from "@/components/print/PrintDocShell";
import { getDocTemplate } from "@/lib/docTemplateStore";
import { contactName, formatDate } from "@/lib/format";

export default async function ServiceReportPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tpl?: string }>;
}) {
  const { id } = await params;
  await requireJobCardReadAccess(id);
  const { tpl: tplId } = await searchParams;
  const jobCard = await prisma.jobCard.findUnique({
    where: { id },
    include: {
      vehicle: true,
      contact: true,
      items: true,
      serviceRecord: { include: { performedBy: true } },
    },
  });
  if (!jobCard) notFound();
  const tpl = await getDocTemplate("service-report", tplId);
  const total = jobCard.items.reduce((s, i) => s + i.qty * i.unitPriceCents, 0);
  const sr = jobCard.serviceRecord;

  return (
    <>
      <PrintActions backHref={`/jobcards/${jobCard.id}`} />
      <PrintDocShell
        template={tpl}
        title="Service report"
        number={`SR-${jobCard.number}`}
        meta={[
          `Service date: ${formatDate(sr?.serviceDate ?? jobCard.completedAt ?? new Date())}`,
          sr?.performedBy ? `Technician: ${sr.performedBy.name}` : "",
          `Job card #${jobCard.number}`,
        ].filter(Boolean)}
        parties={{ left: "Customer · Date", right: "Technician · Date" }}
      >
        <div className="grid grid-cols-2 gap-4 mb-6">
          <InfoBlock
            title="Customer"
            accent
            lines={[contactName(jobCard.contact), jobCard.contact.phone, jobCard.contact.email]}
          />
          <InfoBlock
            title="Vehicle"
            lines={[
              jobCard.vehicle.model,
              jobCard.vehicle.vin ? `VIN: ${jobCard.vehicle.vin}` : null,
              sr?.km != null ? `Odometer: ${sr.km.toLocaleString()} km` : null,
            ]}
          />
        </div>

        {sr?.summary && (
          <div className="rounded-lg bg-slate-50 px-4 py-3 mb-6 no-break">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">
              Work carried out
            </p>
            <p className="text-xs text-slate-700 whitespace-pre-wrap">{sr.summary}</p>
            {sr.details && (
              <p className="mt-1 text-xs text-slate-600 whitespace-pre-wrap">{sr.details}</p>
            )}
          </div>
        )}

        {tpl.sections.items !== false && jobCard.items.length > 0 && (
          <ItemsTable
            rows={jobCard.items.map((i) => ({
              description: `${i.kind === "labour" ? "Labour — " : ""}${i.description}`,
              qty: i.qty,
              unitPriceCents: i.unitPriceCents,
            }))}
            showPrices={tpl.sections.prices === true}
            totalCents={tpl.sections.prices === true ? total : undefined}
          />
        )}

        {tpl.sections.nextdue !== false && (sr?.nextDueDate || sr?.nextDueKm != null) && (
          <div className="rounded-lg border-l-4 border-orange-600 bg-orange-50 px-4 py-3 mt-6 no-break">
            <p className="text-[10px] font-bold uppercase tracking-widest text-orange-600 mb-1">
              Next service due
            </p>
            <p className="text-xs text-slate-700">
              {[
                sr?.nextDueDate ? formatDate(sr.nextDueDate) : null,
                sr?.nextDueKm != null ? `${sr.nextDueKm.toLocaleString()} km` : null,
              ]
                .filter(Boolean)
                .join(" or ")}
            </p>
          </div>
        )}
      </PrintDocShell>
    </>
  );
}
