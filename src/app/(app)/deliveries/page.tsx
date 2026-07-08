import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import {
  markInvoiced,
  markDepositPaid,
  scheduleDelivery,
  uploadDeliveryPhotos,
} from "@/app/actions/fulfilment";
import ProofOfDelivery from "@/components/ProofOfDelivery";
import { contactName, formatDate, formatZAR } from "@/lib/format";

export const metadata = { title: "Deliveries — DenagoCRM" };

type Col = "invoice" | "deposit" | "schedule" | "deliver";

export default async function DeliveriesPage() {
  await requireUser();
  const quotes = await prisma.quote.findMany({
    where: { status: "accepted", deliveredAt: null, supersededAt: null },
    include: { contact: true, lead: { include: { product: true } }, items: true },
    orderBy: { updatedAt: "asc" },
  });
  const docs = await prisma.document.findMany({
    where: { quoteId: { in: quotes.map((q) => q.id) } },
    select: { quoteId: true, tag: true },
  });
  const photoCount = (quoteId: string) =>
    docs.filter((d) => d.quoteId === quoteId && d.tag === "delivery-photo").length;
  const hasDoc = (quoteId: string, tag: string) =>
    docs.some((d) => d.quoteId === quoteId && d.tag === tag);

  const colOf = (q: (typeof quotes)[number]): Col =>
    !q.invoicedAt ? "invoice" : !q.depositPaidAt ? "deposit" : !q.deliveryScheduledFor ? "schedule" : "deliver";

  const columns: { key: Col; title: string; hint: string }[] = [
    { key: "invoice", title: "To invoice", hint: "Signed — send & upload the invoice" },
    { key: "deposit", title: "Awaiting deposit", hint: "Upload proof of payment when it lands" },
    { key: "schedule", title: "Schedule delivery", hint: "Pick the date — goes on the workshop calendar" },
    { key: "deliver", title: "Scheduled", hint: "Mark delivered on handover day" },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Deliveries</h1>
        <p className="text-sm text-slate-400 mt-1">
          Every signed quote moves left to right: invoice → deposit → schedule → delivered.
          Paperwork uploads at each step and files onto the customer automatically.
        </p>
      </div>

      <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4 items-start">
        {columns.map((col) => {
          const cards = quotes.filter((q) => colOf(q) === col.key);
          return (
            <div key={col.key} className="rounded-xl bg-slate-900/60 border border-slate-800 p-3">
              <p className="text-sm font-semibold px-1">{col.title}</p>
              <p className="text-[11px] text-slate-500 px-1 mb-3">{col.hint}</p>
              <div className="space-y-3">
                {cards.length === 0 && (
                  <p className="text-xs text-slate-600 px-1 pb-2">Nothing here.</p>
                )}
                {cards.map((q) => {
                  const total = q.items.reduce((s, i) => s + i.qty * i.unitPriceCents, 0);
                  const model = q.lead?.product?.name ?? q.items[0]?.description ?? "—";
                  const who = q.contact ? contactName(q.contact) : q.lead?.name ?? "—";
                  return (
                    <div key={q.id} className="rounded-lg border border-slate-700 bg-slate-800 p-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <Link
                          href={`/quotes/${q.id}`}
                          className="font-semibold text-orange-400 hover:underline text-sm"
                        >
                          Q-{q.number}
                        </Link>
                        <span className="text-xs font-semibold text-emerald-400">
                          {formatZAR(Math.round(total))}
                        </span>
                      </div>
                      <p className="text-sm mt-0.5">
                        {q.contact ? (
                          <Link href={`/contacts/${q.contact.id}`} className="hover:underline">
                            {who}
                          </Link>
                        ) : (
                          who
                        )}
                      </p>
                      <p className="text-xs text-slate-400 truncate">{model}</p>
                      <p className="text-[11px] text-slate-500 mt-1">
                        {hasDoc(q.id, "invoice") ? "📄 invoice ✓" : ""}
                        {hasDoc(q.id, "pop") ? " · 💰 POP ✓" : ""}
                        {photoCount(q.id) > 0 ? ` · 📷 ${photoCount(q.id)}` : ""}
                        {q.deliveryScheduledFor
                          ? ` · 🚚 ${formatDate(q.deliveryScheduledFor)}`
                          : ""}
                      </p>

                      {col.key === "invoice" && (
                        <form action={markInvoiced.bind(null, q.id)} className="mt-2 space-y-1.5">
                          <input
                            type="file"
                            name="file"
                            required
                            accept=".pdf,image/*"
                            className="block w-full text-xs text-slate-400 file:btn-secondary file:btn-sm file:mr-2 file:border-0"
                          />
                          <button className="btn-primary btn-sm w-full">
                            📄 Mark invoiced (attach invoice)
                          </button>
                        </form>
                      )}
                      {col.key === "deposit" && (
                        <form action={markDepositPaid.bind(null, q.id)} className="mt-2 space-y-1.5">
                          <input
                            type="file"
                            name="file"
                            required
                            accept=".pdf,image/*"
                            className="block w-full text-xs text-slate-400 file:btn-secondary file:btn-sm file:mr-2 file:border-0"
                          />
                          <button className="btn-primary btn-sm w-full">
                            💰 Deposit paid (attach POP)
                          </button>
                        </form>
                      )}
                      {col.key === "schedule" && (
                        <form action={scheduleDelivery.bind(null, q.id)} className="mt-2 space-y-1.5">
                          <input type="date" name="date" required className="input text-xs py-1.5" />
                          <input
                            type="file"
                            name="file"
                            accept=".pdf,image/*"
                            className="block w-full text-xs text-slate-400 file:btn-secondary file:btn-sm file:mr-2 file:border-0"
                          />
                          <button className="btn-primary btn-sm w-full">🚚 Schedule delivery</button>
                        </form>
                      )}
                      {col.key === "deliver" && (
                        <div className="mt-2">
                          <ProofOfDelivery quoteId={q.id} />
                          <p className="text-[10px] text-slate-500 mt-1">
                            Capture driver, handover checklist &amp; signature.
                          </p>
                        </div>
                      )}
                      {col.key === "deliver" && (
                        <form
                          action={uploadDeliveryPhotos.bind(null, q.id)}
                          className="mt-1.5 space-y-1.5"
                        >
                          <input
                            type="file"
                            name="files"
                            multiple
                            accept="image/*"
                            capture="environment"
                            className="block w-full text-xs text-slate-400 file:btn-secondary file:btn-sm file:mr-2 file:border-0"
                          />
                          <button className="btn-secondary btn-sm w-full">
                            📷 Add delivery photos
                          </button>
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
