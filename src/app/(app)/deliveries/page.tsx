import Link from "next/link";
import { Truck, FileText, Wallet, CalendarClock, PackageCheck, ArrowRight } from "lucide-react";
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
import { PageHeader } from "@/components/page-header";
import {
  getAccessibleQuoteIds,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";

export const metadata = { title: "Deliveries — DenagoCRM" };

type Col = "invoice" | "deposit" | "schedule" | "deliver";

const columns: {
  key: Col;
  title: string;
  hint: string;
  accent: string;
  icon: React.ReactNode;
}[] = [
  { key: "invoice", title: "To invoice", hint: "Signed — send & upload the invoice", accent: "#3b82f6", icon: <FileText className="size-3.5" /> },
  { key: "deposit", title: "Awaiting deposit", hint: "Upload proof of payment when it lands", accent: "#f59e0b", icon: <Wallet className="size-3.5" /> },
  { key: "schedule", title: "Schedule delivery", hint: "Pick the date — goes on the workshop calendar", accent: "#a855f7", icon: <CalendarClock className="size-3.5" /> },
  { key: "deliver", title: "Scheduled", hint: "Mark delivered on handover day", accent: "#10b981", icon: <PackageCheck className="size-3.5" /> },
];

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

  const count = (key: Col) => quotes.filter((quote) => colOf(quote) === key).length;
  const pipelineValue = quotes.reduce((sum, quote) => sum + quoteTotalCents(quote.items), 0);

  const stat = "rounded-xl border border-border bg-card p-4";
  const chip = "inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Deliveries"
        description={
          canManage
            ? "Invoice, deposit, scheduling and handover — the whole delivery flow in one board."
            : "Read-only visibility of vehicles moving through to handover."
        }
      />

      {/* Stat strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div className={stat}>
          <div className="text-2xl font-bold text-foreground">{quotes.length}</div>
          <div className="text-xs text-muted-foreground">Active handovers</div>
        </div>
        <div className={stat}>
          <div className="text-2xl font-bold text-blue-300">{count("invoice")}</div>
          <div className="text-xs text-muted-foreground">To invoice</div>
        </div>
        <div className={stat}>
          <div className="text-2xl font-bold text-amber-300">{count("deposit")}</div>
          <div className="text-xs text-muted-foreground">Awaiting deposit</div>
        </div>
        <div className={stat}>
          <div className="text-2xl font-bold text-emerald-300">{count("schedule") + count("deliver")}</div>
          <div className="text-xs text-muted-foreground">Ready / scheduled</div>
        </div>
        <div className={stat}>
          <div className="text-2xl font-bold text-foreground">{formatZAR(Math.round(pipelineValue))}</div>
          <div className="text-xs text-muted-foreground">Pipeline value</div>
        </div>
      </div>

      {quotes.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-10 text-center shadow-sm">
          <div className="mx-auto mb-4 grid size-12 place-items-center rounded-full border border-border bg-muted/40 text-muted-foreground">
            <Truck className="size-6" aria-hidden="true" />
          </div>
          <h2 className="text-base font-semibold text-foreground">No handovers in progress</h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            A quote lands on this board the moment it&apos;s <strong className="font-medium text-foreground">accepted</strong> — then
            moves through invoice → deposit → scheduling → handover, and drops off once you mark it delivered.
            You have no accepted quotes waiting for delivery yet.
          </p>
          <Link
            href="/quotes"
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Go to quotes
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
          <p className="mt-3 text-xs text-muted-foreground/70">
            Accept a quote (or have the customer sign it) and it&apos;ll appear in “To invoice”.
          </p>
        </div>
      ) : (
        <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-4">
          {columns.map((column) => {
            const cards = quotes.filter((quote) => colOf(quote) === column.key);
            return (
              <section key={column.key} className="overflow-hidden rounded-2xl border border-border bg-card/40">
                <header className="relative border-b border-border bg-card/80 px-3.5 py-3">
                  <span className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: column.accent }} />
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="grid size-6 place-items-center rounded-md" style={{ backgroundColor: `${column.accent}22`, color: column.accent }}>
                        {column.icon}
                      </span>
                      <h2 className="text-sm font-semibold text-foreground">{column.title}</h2>
                    </div>
                    <span className="rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
                      {cards.length}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground/80">{column.hint}</p>
                </header>

                <div className="min-h-[8rem] space-y-3 bg-background/20 p-2.5">
                  {cards.length === 0 && (
                    <p className="px-1 py-6 text-center text-xs text-muted-foreground/50">Nothing here.</p>
                  )}
                  {cards.map((quote) => {
                    const total = quoteTotalCents(quote.items);
                    const model = quote.lead?.product?.name ?? quote.items[0]?.description ?? "—";
                    const who = quote.contact ? contactName(quote.contact) : quote.lead?.name ?? "—";
                    const photos = photoCount(quote.id);
                    return (
                      <div key={quote.id} className="rounded-xl border border-border bg-card p-3 shadow-sm transition-colors hover:border-primary/30">
                        <div className="flex items-baseline justify-between gap-2">
                          <Link href={`/quotes/${quote.id}`} className="text-sm font-semibold text-primary hover:underline">
                            Q-{quote.number}
                          </Link>
                          <span className="text-xs font-semibold tabular-nums text-emerald-300">{formatZAR(Math.round(total))}</span>
                        </div>
                        <p className="mt-0.5 text-sm text-foreground">
                          {quote.contact ? (
                            <Link href={`/contacts/${quote.contact.id}`} className="hover:underline">{who}</Link>
                          ) : (
                            who
                          )}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">{model}</p>

                        {(hasDoc(quote.id, "invoice") || hasDoc(quote.id, "pop") || photos > 0 || quote.deliveryScheduledFor) && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {hasDoc(quote.id, "invoice") && <span className={chip}><FileText className="size-2.5" /> Invoice</span>}
                            {hasDoc(quote.id, "pop") && <span className={chip}><Wallet className="size-2.5" /> POP</span>}
                            {photos > 0 && <span className={chip}>📷 {photos}</span>}
                            {quote.deliveryScheduledFor && (
                              <span className={chip}><Truck className="size-2.5" /> {formatDate(quote.deliveryScheduledFor)}</span>
                            )}
                          </div>
                        )}

                        {canManage && column.key === "invoice" && (
                          <form action={markInvoiced.bind(null, quote.id)} className="mt-2.5 space-y-1.5">
                            <input type="file" name="file" required accept=".pdf,image/*" className="block w-full text-xs text-muted-foreground file:btn-secondary file:btn-sm file:mr-2 file:border-0" />
                            <button className="btn-primary btn-sm w-full">Mark invoiced</button>
                          </form>
                        )}
                        {canManage && column.key === "deposit" && (
                          <form action={markDepositPaid.bind(null, quote.id)} className="mt-2.5 space-y-1.5">
                            <input type="file" name="file" required accept=".pdf,image/*" className="block w-full text-xs text-muted-foreground file:btn-secondary file:btn-sm file:mr-2 file:border-0" />
                            <button className="btn-primary btn-sm w-full">Deposit paid</button>
                          </form>
                        )}
                        {canManage && column.key === "schedule" && (
                          <form action={scheduleDelivery.bind(null, quote.id)} className="mt-2.5 space-y-1.5">
                            <input type="date" name="date" required className="input text-xs py-1.5" />
                            <input type="file" name="file" accept=".pdf,image/*" className="block w-full text-xs text-muted-foreground file:btn-secondary file:btn-sm file:mr-2 file:border-0" />
                            <button className="btn-primary btn-sm w-full">Schedule delivery</button>
                          </form>
                        )}
                        {(column.key === "schedule" || column.key === "deliver") && (
                          <a href={`/quotes/${quote.id}/delivery-note`} target="_blank" rel="noreferrer" className="mt-2 block text-xs text-primary hover:underline">
                            🧾 Print delivery note
                          </a>
                        )}
                        {canManage && column.key === "deliver" && (
                          <div className="mt-2.5 border-t border-border/60 pt-2.5">
                            <ProofOfDelivery quoteId={quote.id} />
                            <p className="mt-1 text-[10px] text-muted-foreground/70">Capture driver, handover checklist &amp; signature.</p>
                            <form action={uploadDeliveryPhotos.bind(null, quote.id)} className="mt-1.5 space-y-1.5">
                              <input type="file" name="files" multiple accept="image/*" capture="environment" className="block w-full text-xs text-muted-foreground file:btn-secondary file:btn-sm file:mr-2 file:border-0" />
                              <button className="btn-secondary btn-sm w-full">📷 Add delivery photos</button>
                            </form>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
