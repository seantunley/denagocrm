import Link from "next/link";
import { prisma } from "@/lib/db";
import {
  markInvoiced,
  markDepositPaid,
  scheduleDelivery,
  uploadDeliveryPhotos,
} from "@/app/actions/fulfilment";
import ProofOfDelivery from "@/components/ProofOfDelivery";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import {
  getAccessibleQuoteIds,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";

export const metadata = { title: "Deliveries — DenagoCRM" };

type Col = "invoice" | "deposit" | "schedule" | "deliver";

export default async function DeliveriesPage() {
  const user = await requireAnyPermission("deliveries.view", "deliveries.manage");
  const [quoteIds, canManage] = await Promise.all([
    getAccessibleQuoteIds(user),
    hasPermission(user, "deliveries.manage"),
  ]);
  const quotes = await prisma.quote.findMany({
    where: {
      status: "accepted",
      deliveredAt: null,
      supersededAt: null,
      ...(quoteIds === null ? {} : { id: { in: quoteIds } }),
    },
    include: { contact: true, lead: { include: { product: true } }, items: true },
    orderBy: { updatedAt: "asc" },
  });
  const docs = await prisma.document.findMany({
    where: { quoteId: { in: quotes.map((quote) => quote.id) }, deletedAt: null },
    select: { quoteId: true, tag: true },
  });
  const photoCount = (quoteId: string) =>
    docs.filter((document) => document.quoteId === quoteId && document.tag === "delivery-photo").length;
  const hasDoc = (quoteId: string, tag: string) =>
    docs.some((document) => document.quoteId === quoteId && document.tag === tag);

  const colOf = (quote: (typeof quotes)[number]): Col =>
    !quote.invoicedAt ? "invoice" : !quote.depositPaidAt ? "deposit" : !quote.deliveryScheduledFor ? "schedule" : "deliver";

  const columns: { key: Col; title: string; hint: string }[] = [
    { key: "invoice", title: "To invoice", hint: "Signed — send & upload the invoice" },
    { key: "deposit", title: "Awaiting deposit", hint: "Upload proof of payment when it lands" },
    { key: "schedule", title: "Schedule delivery", hint: "Pick the date — goes on the workshop calendar" },
    { key: "deliver", title: "Scheduled", hint: "Mark delivered on handover day" },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Deliveries"
        description={`${quotes.length} accessible active handover${quotes.length === 1 ? "" : "s"}${canManage ? " · Invoice, deposit, scheduling and delivery in one flow." : " · Read-only delivery visibility."}`}
      />

      <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4 items-start">
        {columns.map((column) => {
          const cards = quotes.filter((quote) => colOf(quote) === column.key);
          return (
            <div key={column.key} className="rounded-xl bg-slate-900/60 border border-slate-800 p-3">
              <p className="text-sm font-semibold px-1">{column.title}</p>
              <p className="text-[11px] text-slate-500 px-1 mb-3">{column.hint}</p>
              <div className="space-y-3">
                {cards.length === 0 && <p className="text-xs text-slate-600 px-1 pb-2">Nothing here.</p>}
                {cards.map((quote) => {
                  const total = quote.items.reduce((sum, item) => sum + item.qty * item.unitPriceCents, 0);
                  const model = quote.lead?.product?.name ?? quote.items[0]?.description ?? "—";
                  const who = quote.contact ? contactName(quote.contact) : quote.lead?.name ?? "—";
                  return (
                    <div key={quote.id} className="rounded-lg border border-slate-700 bg-slate-800 p-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <Link href={`/quotes/${quote.id}`} className="font-semibold text-orange-400 hover:underline text-sm">Q-{quote.number}</Link>
                        <span className="text-xs font-semibold text-emerald-400">{formatZAR(Math.round(total))}</span>
                      </div>
                      <p className="text-sm mt-0.5">
                        {quote.contact ? <Link href={`/contacts/${quote.contact.id}`} className="hover:underline">{who}</Link> : who}
                      </p>
                      <p className="text-xs text-slate-400 truncate">{model}</p>
                      <p className="text-[11px] text-slate-500 mt-1">
                        {hasDoc(quote.id, "invoice") ? "📄 invoice ✓" : ""}
                        {hasDoc(quote.id, "pop") ? " · 💰 POP ✓" : ""}
                        {photoCount(quote.id) > 0 ? ` · 📷 ${photoCount(quote.id)}` : ""}
                        {quote.deliveryScheduledFor ? ` · 🚚 ${formatDate(quote.deliveryScheduledFor)}` : ""}
                      </p>

                      {canManage && column.key === "invoice" && (
                        <form action={markInvoiced.bind(null, quote.id)} className="mt-2 space-y-1.5">
                          <input type="file" name="file" required accept=".pdf,image/*" className="block w-full text-xs text-slate-400 file:btn-secondary file:btn-sm file:mr-2 file:border-0" />
                          <button className="btn-primary btn-sm w-full">📄 Mark invoiced (attach invoice)</button>
                        </form>
                      )}
                      {canManage && column.key === "deposit" && (
                        <form action={markDepositPaid.bind(null, quote.id)} className="mt-2 space-y-1.5">
                          <input type="file" name="file" required accept=".pdf,image/*" className="block w-full text-xs text-slate-400 file:btn-secondary file:btn-sm file:mr-2 file:border-0" />
                          <button className="btn-primary btn-sm w-full">💰 Deposit paid (attach POP)</button>
                        </form>
                      )}
                      {canManage && column.key === "schedule" && (
                        <form action={scheduleDelivery.bind(null, quote.id)} className="mt-2 space-y-1.5">
                          <input type="date" name="date" required className="input text-xs py-1.5" />
                          <input type="file" name="file" accept=".pdf,image/*" className="block w-full text-xs text-slate-400 file:btn-secondary file:btn-sm file:mr-2 file:border-0" />
                          <button className="btn-primary btn-sm w-full">🚚 Schedule delivery</button>
                        </form>
                      )}
                      {(column.key === "schedule" || column.key === "deliver") && (
                        <a href={`/quotes/${quote.id}/delivery-note`} target="_blank" rel="noreferrer" className="mt-2 block text-xs text-orange-400 hover:underline">🧾 Print delivery note</a>
                      )}
                      {canManage && column.key === "deliver" && (
                        <div className="mt-2">
                          <ProofOfDelivery quoteId={quote.id} />
                          <p className="text-[10px] text-slate-500 mt-1">Capture driver, handover checklist &amp; signature.</p>
                        </div>
                      )}
                      {canManage && column.key === "deliver" && (
                        <form action={uploadDeliveryPhotos.bind(null, quote.id)} className="mt-1.5 space-y-1.5">
                          <input type="file" name="files" multiple accept="image/*" capture="environment" className="block w-full text-xs text-slate-400 file:btn-secondary file:btn-sm file:mr-2 file:border-0" />
                          <button className="btn-secondary btn-sm w-full">📷 Add delivery photos</button>
                        </form>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
