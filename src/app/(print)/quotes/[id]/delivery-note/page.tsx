import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireQuoteReadAccess } from "@/lib/permissions";
import PrintActions from "@/components/PrintActions";
import PrintDocShell, { ItemsTable, InfoBlock } from "@/components/print/PrintDocShell";
import { getCompanyProfile } from "@/lib/companyProfile";
import { getDocTemplate } from "@/lib/docTemplateStore";
import { formatDate } from "@/lib/format";
import { documentTotals, feeRows, includedLines } from "@/lib/pricing";
import { loadBillToFleet, quoteBillTo } from "@/lib/quoteBillTo";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { deliveryNoteRuns } from "@/lib/checklists/deliveryHandover";

type GuidedEntry = {
  id: string;
  labelSnapshot: string;
  captureSnapshot: string;
  status: string;
  note: string | null;
  value: string | null;
  skipReason: string | null;
  photos: Array<{ id: string }>;
};

function guidedEntryDetail(entry: GuidedEntry): string | null {
  if (entry.status === "skipped" || entry.status === "na") {
    return entry.skipReason ? `Skipped — ${entry.skipReason}` : "Skipped";
  }
  if (entry.captureSnapshot === "boolean") {
    if (entry.value === "true") return "Yes";
    if (entry.value === "false") return "No";
  }
  if (entry.captureSnapshot === "text" || entry.captureSnapshot === "number") {
    return entry.value?.trim() || null;
  }
  if (entry.captureSnapshot === "photo" || entry.captureSnapshot === "photo_note") {
    const evidence = `${entry.photos.length} photo${entry.photos.length === 1 ? "" : "s"}`;
    return entry.note?.trim() ? `${evidence} · ${entry.note.trim()}` : evidence;
  }
  return entry.note?.trim() || entry.value?.trim() || null;
}

export default async function DeliveryNotePrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tpl?: string; embed?: string }>;
}) {
  const { id } = await params;
  // The (print) layout guard treats /quotes as core, so this automotive delivery
  // note slips through it. A delivery note is automotive paperwork — 404 it
  // explicitly when the automotive pack is off.
  if (!(await isModuleEnabled("automotive"))) notFound();
  await requireQuoteReadAccess(id);
  const { tpl: tplId, embed } = await searchParams;
  const embedded = embed === "1";
  const quote = await prisma.quote.findUnique({
    where: { id },
    include: { items: true, fees: { orderBy: { sortOrder: "asc" } }, contact: true, lead: true },
  });
  if (!quote) notFound();

  const guidedRuns = quote.tenantId
    ? await prisma.checklistRun.findMany({
        where: {
          tenantId: quote.tenantId,
          hostType: "quote.delivery",
          hostId: quote.id,
          completedAt: { not: null },
        },
        orderBy: { completedAt: "desc" },
        select: {
          id: true,
          templateId: true,
          completedAt: true,
          template: { select: { name: true, sortOrder: true } },
          entries: {
            orderBy: { sortOrder: "asc" },
            select: {
              id: true,
              labelSnapshot: true,
              captureSnapshot: true,
              status: true,
              note: true,
              value: true,
              skipReason: true,
              photos: { select: { id: true } },
            },
          },
        },
      })
    : [];

  // A delivery checklist is repeatable by design, but the delivery note should
  // show the run the customer is actually signing, not every historical retry.
  //
  // ONCE SIGNED, THAT IS DECIDED AND THIS MUST NOT RE-DECIDE IT. Choosing the
  // newest completed run per template on every render meant a checklist re-run
  // AFTER handover silently replaced the evidence beside a signature the customer
  // had already given — the document changed after it was signed. The per-entry
  // snapshots froze the template's wording; nothing froze WHICH RUN.
  //
  // completeGuidedDelivery now records the ids at the moment of signing, in the
  // same write that records the delivery. Where they exist they are the whole
  // answer, and a later run cannot appear on this note however new it is.
  const guidedRunsForNote = deliveryNoteRuns(guidedRuns, quote.deliveryHandoverRunIds);

  const signatureDoc = quote.deliverySignatureRef
    ? await prisma.document.findFirst({
        where: { quoteId: quote.id, tag: "delivery-signature", deletedAt: null },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      })
    : null;

  // The company this document is FROM. getCompanyProfile now inherits the
  // platform-set tenant brand when the tenant has not filled in its own profile.
  const company = await getCompanyProfile();
  const tpl = await getDocTemplate("delivery", tplId);
  // Fees and delivery are part of what the customer pays; the subtotal is not.
  const totals = documentTotals(quote);
  // "Deliver to" and "bill to" are the same entity here on purpose: six carts
  // bought by a lodge are delivered to the lodge, and the fleet's address is the
  // one the driver needs. The manager still appears, as the person to ask for on
  // arrival, which is exactly what the attention line is.
  const billTo = quoteBillTo(quote, await loadBillToFleet(prisma, quote.fleetId));
  const customer = billTo.name;
  const legacyChecklist = (quote.deliveryChecklist ?? {}) as Record<string, boolean>;
  const legacyChecklistEntries = Object.entries(legacyChecklist);

  return (
    <>
      {!embedded && <PrintActions backHref="/deliveries" backLabel="Back to deliveries" />}
      <PrintDocShell
        company={company}
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
          <InfoBlock
            title="Deliver to"
            accent
            lines={[
              customer,
              billTo.attention ? `Ask for: ${billTo.attention}` : "",
              billTo.phone,
              billTo.address,
            ]}
          />
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
            // Fee rows go in whenever prices are shown: the total below counts
            // them, so leaving them out gave a priced delivery note whose rows
            // didn't add up. With prices off the table is a packing list, and a
            // delivery charge is not a thing being delivered.
            rows={tpl.sections.prices === true ? [...includedLines(quote.items), ...feeRows(quote.fees)] : includedLines(quote.items)}
            showPrices={tpl.sections.prices === true}
            totals={tpl.sections.prices === true ? totals : undefined}
          />
        )}

        {tpl.sections.checklist !== false && (
          <div className="rounded-lg bg-slate-50 px-4 py-3 mt-6 no-break">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-2">
              Handover checklist
            </p>

            {guidedRunsForNote.length > 0 ? (
              <div className="space-y-4">
                {guidedRunsForNote.map((run) => (
                  <div key={run.id}>
                    <div className="mb-1.5 flex items-baseline justify-between gap-3">
                      <p className="text-xs font-semibold text-slate-800">{run.template.name}</p>
                      {run.completedAt && (
                        <p className="text-[10px] text-slate-500">Completed {formatDate(run.completedAt)}</p>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
                      {run.entries.map((entry) => {
                        const detail = guidedEntryDetail(entry);
                        const done = entry.status === "done";
                        return (
                          <div key={entry.id} className="flex items-start gap-2 text-xs text-slate-700">
                            <span className="mt-px inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border border-slate-400 text-[9px] leading-none">
                              {done ? "✓" : entry.status === "skipped" || entry.status === "na" ? "—" : ""}
                            </span>
                            <span>
                              <span>{entry.labelSnapshot}</span>
                              {detail && <span className="block text-[10px] text-slate-500">{detail}</span>}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
                {(legacyChecklistEntries.length
                  ? legacyChecklistEntries
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
            )}
          </div>
        )}

        {signatureDoc && (
          <div className="mt-6 rounded-lg border border-slate-200 px-4 py-3 no-break">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">
              Customer signature
            </p>
            {/* eslint-disable-next-line @next/next/no-img-element -- authenticated document route */}
            <img
              src={`/api/files/${signatureDoc.id}`}
              alt="Customer signature"
              className="h-20 max-w-full object-contain object-left"
            />
            {quote.deliveredAt && (
              <p className="mt-1 text-[10px] text-slate-500">Recorded on {formatDate(quote.deliveredAt)}</p>
            )}
          </div>
        )}
      </PrintDocShell>
    </>
  );
}
