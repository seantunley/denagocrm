import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireLeadReadAccess } from "@/lib/permissions";
import PrintActions from "@/components/PrintActions";
import PrintDocShell, { InfoBlock } from "@/components/print/PrintDocShell";
import { getDocTemplate } from "@/lib/docTemplateStore";
import { formatDate } from "@/lib/format";

export default async function IndemnityPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tpl?: string }>;
}) {
  const { id } = await params;
  await requireLeadReadAccess(id);
  const { tpl: tplId } = await searchParams;
  const lead = await prisma.lead.findUnique({
    where: { id },
    include: { product: true, contact: true },
  });
  if (!lead) notFound();
  const tpl = await getDocTemplate("indemnity", tplId);

  return (
    <>
      <PrintActions backHref={`/leads/${lead.id}`} backLabel="Back to lead" />
      <PrintDocShell
        template={tpl}
        title="Test-drive indemnity"
        meta={[`Date: ${formatDate(new Date())}`]}
        parties={{ left: "Driver signature · Date", right: "For Denago Cape Town · Date" }}
        bodySection="waiver"
        bodyTitle="Indemnity & waiver"
      >
        <div className="grid grid-cols-2 gap-4 mb-6">
          <InfoBlock
            title="Driver"
            accent
            lines={[lead.name, lead.phone, lead.email]}
          />
          <InfoBlock
            title="Vehicle"
            lines={[
              lead.product?.name ?? "Denago EV",
              lead.color ? `Colour: ${lead.color}` : null,
            ]}
          />
        </div>
        <div className="rounded-lg bg-slate-50 px-4 py-3 no-break">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-2">
            To be completed by the driver
          </p>
          <div className="grid grid-cols-2 gap-x-8 gap-y-6 pt-2 text-xs text-slate-600">
            <p className="border-b border-slate-400 pb-1">Driver&apos;s licence number:</p>
            <p className="border-b border-slate-400 pb-1">ID / passport number:</p>
          </div>
        </div>
      </PrintDocShell>
    </>
  );
}
