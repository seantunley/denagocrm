import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDollarSign,
  ClipboardCheck,
  FileText,
  PackageCheck,
  Truck,
} from "lucide-react";
import { prisma } from "@/lib/db";
import {
  markInvoiced,
  markDepositPaid,
  scheduleDelivery,
  uploadDeliveryPhotos,
} from "@/app/actions/fulfilment";
import ProofOfDelivery from "@/components/ProofOfDelivery";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { quoteTotalCents } from "@/lib/pricing";
import { getQuoteStockAssignments } from "@/lib/stockPlatform";
import { PageHeader } from "@/components/page-header";
import {
  getAccessibleQuoteIds,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";
import { MetricCard, StatusPill, Surface } from "@/components/visual-system";

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
  const [docs, assignments] = await Promise.all([
    prisma.document.findMany({
      where: { quoteId: { in: quotes.map((quote) => quote.id) }, deletedAt: null },
      select: { quoteId: true, tag: true },
    }),
    getQuoteStockAssignments(quotes.map((quote) => quote.id)),
  ]);
  const assignmentByQuote = new Map(assignments.map((assignment) => [assignment.quoteId, assignment]));
  const photoCount = (quoteId: string) => docs.filter((document) => document.quoteId === quoteId && document.tag === "delivery-photo").length;
  const hasDoc = (quoteId: string, tag: string) => docs.some((document) => document.quoteId === quoteId && document.tag === tag);
  const colOf = (quote: (typeof quotes)[number]): Col => !quote.invoicedAt ? "invoice" : !quote.depositPaidAt ? "deposit" : !quote.deliveryScheduledFor ? "schedule" : "deliver";
  const columns: { key: Col; title: string; hint: string; icon: typeof FileText }[] = [
    { key: "invoice", title: "To invoice", hint: "Accepted — issue and file invoice", icon: FileText },
    { key: "deposit", title: "Awaiting deposit", hint: "Record proof of payment", icon: CircleDollarSign },
    { key: "schedule", title: "Allocate & schedule", hint: "Physical unit required", icon: PackageCheck },
    { key: "deliver", title: "Handover", hint: "PDI-ready units only", icon: Truck },
  ];
  const readyCount = assignments.filter((assignment) => assignment.status === "ready" && assignment.pdiStatus === "completed").length;
  const missingStock = quotes.filter((quote) => quote.depositPaidAt && !assignmentByQuote.has(quote.id)).length;

  return (
    <div className="denago-workspace space-y-6">
      <PageHeader
        title="Deliveries"
        description={`${quotes.length} active handover${quotes.length === 1 ? "" : "s"} · invoice, deposit, exact stock allocation, PDI and customer delivery in one controlled flow.`}
      />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard icon={FileText} label="Active handovers" value={quotes.length} detail={canManage ? "Managed fulfilment" : "Read-only visibility"} accent />
        <MetricCard icon={PackageCheck} label="Units ready" value={readyCount} detail="PDI complete" />
        <MetricCard icon={AlertTriangle} label="Missing stock allocation" value={missingStock} detail="Deposit paid, no unit assigned" />
        <MetricCard icon={ClipboardCheck} label="Scheduled" value={quotes.filter((quote) => quote.deliveryScheduledFor).length} detail="On the workshop calendar" />
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4 items-start">
        {columns.map((column) => {
          const cards = quotes.filter((quote) => colOf(quote) === column.key);
          const Icon = column.icon;
          return (
            <Surface key={column.key} className="p-3">
              <div className="flex items-start gap-3 px-1 pb-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-muted/40 text-muted-foreground"><Icon className="size-4" /></span>
                <div><p className="text-sm font-semibold text-foreground">{column.title}</p><p className="mt-0.5 text-[11px] text-muted-foreground">{column.hint}</p></div>
              </div>
              <div className="space-y-3">
                {cards.length === 0 && <div className="rounded-xl border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">Nothing here.</div>}
                {cards.map((quote) => {
                  const total = quoteTotalCents(quote.items);
                  const model = quote.lead?.product?.name ?? quote.items[0]?.description ?? "—";
                  const who = quote.contact ? contactName(quote.contact) : quote.lead?.name ?? "—";
                  const stock = assignmentByQuote.get(quote.id);
                  const stockReady = stock && ["ready", "sold"].includes(stock.status) && stock.pdiStatus === "completed";
                  return (
                    <div key={quote.id} className="rounded-2xl border border-border bg-background/40 p-4 shadow-sm">
                      <div className="flex items-baseline justify-between gap-2"><Link href={`/quotes/${quote.id}`} className="font-semibold text-primary hover:underline">Q-{quote.number}</Link><span className="text-xs font-semibold text-emerald-400">{formatZAR(Math.round(total))}</span></div>
                      <p className="mt-1 text-sm font-medium text-foreground">{quote.contact ? <Link href={`/contacts/${quote.contact.id}`} className="hover:text-primary hover:underline">{who}</Link> : who}</p>
                      <p className="truncate text-xs text-muted-foreground">{model}</p>

                      <div className="mt-3 rounded-xl border border-border bg-card/60 p-3">
                        {stock ? (
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0"><Link href={`/stock/${stock.stockUnitId}`} className="truncate text-xs font-semibold text-foreground hover:text-primary hover:underline">{stock.stockNumber ?? stock.productName}</Link><p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{stock.serial ?? "Serial pending"} · {stock.color ?? "No colour"}</p></div>
                            <StatusPill tone={stockReady ? "success" : stock.status === "pdi" ? "warning" : "info"}>{stockReady ? "Ready" : stock.status === "pdi" ? "PDI" : stock.status}</StatusPill>
                          </div>
                        ) : (
                          <div className="flex items-start gap-2 text-amber-200"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><div><p className="text-xs font-semibold">No physical unit allocated</p><p className="mt-1 text-[10px] text-amber-100/70">Allocate an available matching unit before scheduling.</p></div></div>
                        )}
                      </div>

                      <p className="mt-3 text-[11px] text-muted-foreground">
                        {hasDoc(quote.id, "invoice") ? "Invoice ✓" : ""}{hasDoc(quote.id, "pop") ? " · POP ✓" : ""}{photoCount(quote.id) > 0 ? ` · ${photoCount(quote.id)} photos` : ""}{quote.deliveryScheduledFor ? ` · ${formatDate(quote.deliveryScheduledFor)}` : ""}
                      </p>

                      {canManage && column.key === "invoice" && (
                        <form action={markInvoiced.bind(null, quote.id)} className="mt-3 space-y-2"><input type="file" name="file" required accept=".pdf,image/*" className="block w-full text-xs text-muted-foreground file:btn-secondary file:btn-sm file:mr-2 file:border-0" /><button className="btn-primary btn-sm w-full">File invoice</button></form>
                      )}
                      {canManage && column.key === "deposit" && (
                        <form action={markDepositPaid.bind(null, quote.id)} className="mt-3 space-y-2"><input type="file" name="file" required accept=".pdf,image/*" className="block w-full text-xs text-muted-foreground file:btn-secondary file:btn-sm file:mr-2 file:border-0" /><button className="btn-primary btn-sm w-full">Record deposit</button></form>
                      )}
                      {canManage && column.key === "schedule" && stock && (
                        <form action={scheduleDelivery.bind(null, quote.id)} className="mt-3 space-y-2"><input type="date" name="date" required className="input text-xs" /><input type="file" name="file" accept=".pdf,image/*" className="block w-full text-xs text-muted-foreground file:btn-secondary file:btn-sm file:mr-2 file:border-0" /><button className="btn-primary btn-sm w-full"><Truck className="size-4" /> Schedule delivery</button></form>
                      )}
                      {canManage && column.key === "schedule" && !stock && (
                        <Link href={`/stock?status=available${quote.lead?.productId ? `&product=${quote.lead.productId}` : ""}`} className="btn-secondary btn-sm mt-3 w-full">Find matching stock</Link>
                      )}
                      {(column.key === "schedule" || column.key === "deliver") && <a href={`/quotes/${quote.id}/delivery-note`} target="_blank" rel="noreferrer" className="mt-3 block text-xs text-primary hover:underline">Print delivery note</a>}
                      {canManage && column.key === "deliver" && stockReady && (
                        <div className="mt-3"><ProofOfDelivery quoteId={quote.id} /><p className="mt-1 text-[10px] text-muted-foreground">Completes stock, warranty and vehicle registration atomically.</p></div>
                      )}
                      {canManage && column.key === "deliver" && !stockReady && stock && (
                        <Link href={`/stock/${stock.stockUnitId}`} className="btn-secondary btn-sm mt-3 w-full">Complete PDI first</Link>
                      )}
                      {canManage && column.key === "deliver" && (
                        <form action={uploadDeliveryPhotos.bind(null, quote.id)} className="mt-2 space-y-2"><input type="file" name="files" multiple accept="image/*" capture="environment" className="block w-full text-xs text-muted-foreground file:btn-secondary file:btn-sm file:mr-2 file:border-0" /><button className="btn-secondary btn-sm w-full">Add delivery photos</button></form>
                      )}
                    </div>
                  );
                })}
              </div>
            </Surface>
          );
        })}
      </div>

      <Surface className="border-emerald-400/20 bg-emerald-400/5 p-5">
        <div className="flex items-start gap-3"><CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-300" /><div><p className="font-semibold text-emerald-100">Stock-backed handover</p><p className="mt-1 text-sm leading-6 text-emerald-100/70">When a ready unit is delivered, DenagoCRM marks the exact stock record delivered, fulfils its reservation, starts the warranty and creates the customer vehicle automatically from its model, colour and serial.</p></div></div>
      </Surface>
    </div>
  );
}
