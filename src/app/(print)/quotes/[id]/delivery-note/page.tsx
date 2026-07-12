import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireQuoteReadAccess } from "@/lib/permissions";
import PrintActions from "@/components/PrintActions";
import PrintDocShell, { ItemsTable, InfoBlock } from "@/components/print/PrintDocShell";
import { getDocTemplate } from "@/lib/docTemplateStore";
import { contactName, formatDate } from "@/lib/format";

export default async function DeliveryNotePrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tpl?: string }>;
}) {
  const { id } = await params;
  await requireQuoteReadAccess(id);
  const { tpl: tplId } = await searchParams;
  const quote = await prisma.quote.findUnique({
    where: { id },
    include: { items: true, contact: true, lead: true },
  });
  if (!quote) notFound();
  const tpl = await getDocTemplate("delivery", tplId);
  const total = quote.items.reduce((s, i) => s + i.qty * i.unitPriceCents, 0);
  const customer = quote.contact ? contactName(quote.contact) : quote.lead?.name ?? "";
  const address = quote.contact
    ? [quote.contact.address, quote.contact.suburb, quote.contact.city].filter(Boolean).join(", ")
    : "";
  const checklist = (quote.deliveryChecklist ?? {}) as Record<string, boolean>;
  const checklistEntries = Object.entries(checklist);

  return (
    <>
      <PrintActions backHref="/deliveries" />
      <PrintDocShell
        template={tpl}
        title="Delivery note"
        number={`DN-${quote.number}`}
        meta={[
          `Date: ${formatDate(quote.deliveredAt ?? quote.deliveryScheduledFor ?? new Date())}`,
          quote.deliveredByName ? `Delivered by: ${quote.deliveredByName}` : "",
          `Reference: Q-${quote.number}`,
        ].filter(Boolean)}
        parties={{ left: "Received in good order — customer · Date", right: "Driver · Date" }}
      >
        <div className="grid grid-cols-2 gap-4 mb-6">
          <InfoBlock title="Deliver to" accent lines={[customer, quote.contact?.phone ?? quote.lead?.phone, address]} />
          <InfoBlock
            title="Delivery details"
            lines={[
              quote.deliveryScheduledFor ? `Scheduled: ${formatDate(quote.deliveryScheduledFor)}` : null,
              quote.deliveredAt ? `Delivered: ${formatDate(quote.deliveredAt)}` : "Not yet delivered",
              quote.deliveredByName ? `Driver: ${quote.deliveredByName}` : null,
            ]}
          />
        </div>

        {tpl.sections.items !== false && (
          <ItemsTable
            rows={quote.items}
            showPrices={tpl.sections.prices === true}
            totalCents={tpl.sections.prices === true ? total : undefined}
          />
        )}

        {tpl.sections.checklist !== false && (
          <div className="rounded-lg bg-slate-50 px-4 py-3 mt-6 no-break">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-2">
              Handover checklist
            </p>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
              {(checklistEntries.length
                ? checklistEntries
                : [
                    ["Battery fully charged", false],
                    ["Charger & cable handed over", false],
                    ["Keys handed over", false],
                    ["Owner's manual provided", false],
                    ["Controls & safety walkthrough done", false],
                    ["Cart inspected — no visible damage", false],
                  ]
              ).map(([label, done]) => (
                <p key={String(label)} className="flex items-center gap-2 text-xs text-slate-700">
                  <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded border border-slate-400 text-[9px] leading-none">
                    {done ? "✓" : ""}
                  </span>
                  {String(label)}
                </p>
              ))}
            </div>
          </div>
        )}
      </PrintDocShell>
    </>
  );
}
