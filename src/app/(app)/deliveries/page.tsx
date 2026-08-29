import Link from "next/link";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { Truck, FileText, Wallet, CalendarClock, PackageCheck, ArrowRight, Camera } from "lucide-react";
import DirectPhotoUploader from "@/components/DirectPhotoUploader";
import { prisma } from "@/lib/db";
import {
  markInvoiced,
  markDepositPaid,
  scheduleDelivery,
} from "@/app/actions/fulfilment";
import ProofOfDelivery from "@/components/ProofOfDelivery";
import { formatDate, formatZAR } from "@/lib/format";
import { loadBillToFleets, quoteBillTo } from "@/lib/quoteBillTo";
import { quotePricing } from "@/lib/pricing";
import { WorkspaceHero } from "@/components/workspace-hero";
import {
  getAccessibleQuoteIds,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";
import {
  DesktopOnly,
  MobileOnly,
  MobileSection,
  MobileStatPair,
  MobileWorkspaceHeader,
} from "@/components/mobile-workspace";

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
    // fees included: the board showed the line-items subtotal, so a quote with a
    // delivery charge appeared here for LESS than the customer was quoted.
    include: { contact: true, lead: { include: { product: true } }, items: true, fees: true },
    orderBy: { updatedAt: "asc" },
  });
  // One batched, tenant-scoped lookup for the board — see lib/quoteBillTo.ts.
  const fleetsById = await loadBillToFleets(prisma, quotes.map((quote) => quote.fleetId));
  const docs = await prisma.document.findMany({
    where: { quoteId: { in: quotes.map((quote) => quote.id) }, deletedAt: null },
    select: { quoteId: true, tag: true },
  });
  const photoCount = (quoteId: string) =>
    docs.filter((document) => document.quoteId === quoteId && document.tag === "delivery-photo").length;
  const hasDoc = (quoteId: string, tag: string) =>
    docs.some((document) => document.quoteId === quoteId && document.tag === tag);

  // Stock-readiness signal: which allocated unit (if any) is furthest from handover.
  // Non-disruptive — the quote-fulfilment flow is unchanged; this just links the two.
  const stockUnits = await prisma.stockUnit.findMany({
    where: { soldQuoteId: { in: quotes.map((quote) => quote.id) }, deletedAt: null },
    select: { id: true, soldQuoteId: true, status: true },
  });
  const STOCK_RANK: Record<string, number> = { allocated: 0, pdi: 1, ready_for_delivery: 2, delivered: 3, sold: 3 };
  const stockByQuote = new Map<string, { status: string; unitId: string; count: number }>();
  for (const unit of stockUnits) {
    if (!unit.soldQuoteId) continue;
    const existing = stockByQuote.get(unit.soldQuoteId);
    if (!existing) stockByQuote.set(unit.soldQuoteId, { status: unit.status, unitId: unit.id, count: 1 });
    else {
      existing.count += 1;
      if ((STOCK_RANK[unit.status] ?? 0) < (STOCK_RANK[existing.status] ?? 0)) {
        existing.status = unit.status;
        existing.unitId = unit.id;
      }
    }
  }
  const STOCK_CHIP: Record<string, { label: string; cls: string }> = {
    allocated: { label: "Stock allocated", cls: "border-blue-500/30 bg-blue-500/10 text-blue-300" },
    pdi: { label: "In PDI", cls: "border-amber-500/30 bg-amber-500/10 text-amber-300" },
    ready_for_delivery: { label: "Ready to hand over", cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" },
    delivered: { label: "Handed over", cls: "border-border bg-muted/40 text-muted-foreground" },
    sold: { label: "Handed over", cls: "border-border bg-muted/40 text-muted-foreground" },
  };

  const colOf = (quote: (typeof quotes)[number]): Col =>
    !quote.invoicedAt ? "invoice" : !quote.depositPaidAt ? "deposit" : !quote.deliveryScheduledFor ? "schedule" : "deliver";

  const count = (key: Col) => quotes.filter((quote) => colOf(quote) === key).length;
  const quoteTotal = (quote: (typeof quotes)[number]) =>
    quotePricing(quote.items, quote.fees, {
      taxInclusive: quote.taxInclusive,
      depositType: quote.depositType,
      depositValue: quote.depositValue,
    }).totalCents;
  const pipelineValue = quotes.reduce((sum, quote) => sum + quoteTotal(quote), 0);

  const chip = "inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground";

  return (
    <>
      <MobileOnly className="space-y-4">
        <MobileWorkspaceHeader
          title="Deliveries"
          description="Capture handover photos and check what each delivery needs next."
          action={<Link href="/quotes" className="btn-secondary btn-sm"><FileText className="size-4" />Quotes</Link>}
        />
        <MobileStatPair items={[
          { label: "Active handovers", value: quotes.length },
          { label: "Ready / scheduled", value: count("schedule") + count("deliver") },
        ]} />
        <MobileSection title="Handover queue" detail={`${quotes.length} vehicle${quotes.length === 1 ? "" : "s"}`}>
          {quotes.length === 0 ? (
            <div className="rounded-2xl border border-border bg-card py-10 text-center text-sm text-muted-foreground">No handovers in progress.</div>
          ) : (
            <div className="space-y-2.5">
              {quotes.map((quote) => {
                const model = quote.lead?.product?.name ?? quote.items[0]?.description ?? "Vehicle";
                const who = quoteBillTo(quote, fleetsById.get(quote.fleetId ?? "") ?? null).name || "Customer";
                const stageKey = colOf(quote);
                const stage = columns.find((column) => column.key === stageKey);
                const photos = photoCount(quote.id);
                return (
                  <article key={quote.id} className="rounded-2xl border border-border bg-card p-3.5">
                    <div className="flex items-start gap-3">
                      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-emerald-400/10 text-emerald-300"><Truck className="size-4" /></span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0"><Link href={`/quotes/${quote.id}`} className="text-sm font-semibold text-primary">Q-{quote.number} · {who}</Link><p className="mt-0.5 truncate text-xs text-muted-foreground">{model}</p></div>
                          <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground">{stage?.title}</span>
                        </div>
                        <p className="mt-2 text-[11px] text-muted-foreground">{photos} handover photo{photos === 1 ? "" : "s"}{quote.deliveryScheduledFor ? ` · ${formatDate(quote.deliveryScheduledFor)}` : ""}</p>
                      </div>
                    </div>
                    {canManage && (
                      <DirectPhotoUploader kind="delivery" recordId={quote.id} tenantId={quote.tenantId ?? ""} label="Add handover photos" />
                    )}
                    {(stageKey === "schedule" || stageKey === "deliver") && (
                      <div className="mt-3 border-t border-border/60 pt-3">
                        <Link
                          href={`/quotes/${quote.id}/delivery-note`}
                          className="btn-secondary btn-sm w-full justify-center"
                        >
                          <FileText className="size-4" />
                          Review delivery note
                        </Link>
                        {canManage && stageKey === "deliver" ? (
                          <>
                            <ProofOfDelivery quoteId={quote.id} baseVersion={quote.updatedAt.toISOString()} />
                            <p className="mt-1 text-[10px] text-muted-foreground/70">
                              Review the note, then capture the driver, handover checklist and customer signature on this device.
                            </p>
                          </>
                        ) : (
                          <p className="mt-1.5 text-[10px] text-muted-foreground/70">
                            {canManage
                              ? "Customer signing becomes available here once the delivery is scheduled."
                              : "Delivery note is available for review."}
                          </p>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </MobileSection>
      </MobileOnly>

      <DesktopOnly className="space-y-6">
      <WorkspaceHero
        icon={Truck}
        eyebrow="Fulfilment operations"
        title="Deliveries"
        description={
          canManage
            ? "Invoice, deposit, scheduling and handover — the whole delivery flow in one board."
            : "Read-only visibility of vehicles moving through to handover."
        }
        actions={<Link href="/quotes" className="btn-secondary btn-sm"><FileText className="size-4" /> Open quotes</Link>}
        stats={[
          { label: "Active handovers", value: quotes.length, detail: formatZAR(Math.round(pipelineValue)), icon: Truck },
          { label: "To invoice", value: count("invoice"), detail: "Accepted, ready to invoice", icon: FileText, tone: "primary" },
          { label: "Awaiting deposit", value: count("deposit"), detail: "Payment confirmation", icon: Wallet, tone: count("deposit") ? "warning" : "default" },
          { label: "Ready / scheduled", value: count("schedule") + count("deliver"), detail: "Handover pipeline", icon: PackageCheck, tone: "success" },
        ]}
      />

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
                    const total = quoteTotal(quote);
                    const model = quote.lead?.product?.name ?? quote.items[0]?.description ?? "—";
                    // The account the delivery is for, resolved the same way the
                    // delivery note resolves it — a board naming the manager
                    // while the paperwork names the lodge is two answers.
                    const who = quoteBillTo(quote, fleetsById.get(quote.fleetId ?? "") ?? null).name || "—";
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

                        {stockByQuote.has(quote.id) && (() => {
                          const s = stockByQuote.get(quote.id)!;
                          const meta = STOCK_CHIP[s.status] ?? { label: s.status.replaceAll("_", " "), cls: "border-border bg-muted/40 text-muted-foreground" };
                          return (
                            <Link
                              href={`/stock/${s.unitId}`}
                              className={`mt-2 inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${meta.cls}`}
                              title="Allocated stock — open the unit"
                            >
                              <PackageCheck className="size-2.5" /> {meta.label}{s.count > 1 ? ` · ${s.count} units` : ""}
                            </Link>
                          );
                        })()}

                        {canManage && column.key === "invoice" && (
                          <SaveForm success="Invoice recorded" resetOnSuccess={false} action={markInvoiced.bind(null, quote.id)} className="mt-2.5 space-y-1.5">
                            <input type="file" name="file" required accept=".pdf,image/*" className="block w-full text-xs text-muted-foreground file:btn-secondary file:btn-sm file:mr-2 file:border-0" />
                            <SaveButton className="btn-primary btn-sm w-full">Mark invoiced</SaveButton>
                          </SaveForm>
                        )}
                        {canManage && column.key === "deposit" && (
                          <SaveForm success="Deposit recorded" resetOnSuccess={false} action={markDepositPaid.bind(null, quote.id)} className="mt-2.5 space-y-1.5">
                            <input type="file" name="file" required accept=".pdf,image/*" className="block w-full text-xs text-muted-foreground file:btn-secondary file:btn-sm file:mr-2 file:border-0" />
                            <SaveButton className="btn-primary btn-sm w-full">Deposit paid</SaveButton>
                          </SaveForm>
                        )}
                        {canManage && column.key === "schedule" && (
                          <SaveForm success="Delivery scheduled" resetOnSuccess={false} action={scheduleDelivery.bind(null, quote.id)} className="mt-2.5 space-y-1.5">
                            <input type="date" name="date" required className="input text-xs py-1.5" />
                            <input type="file" name="file" accept=".pdf,image/*" className="block w-full text-xs text-muted-foreground file:btn-secondary file:btn-sm file:mr-2 file:border-0" />
                            <SaveButton className="btn-primary btn-sm w-full">Schedule delivery</SaveButton>
                          </SaveForm>
                        )}
                        {(column.key === "schedule" || column.key === "deliver") && (
                          <a href={`/quotes/${quote.id}/delivery-note`} target="_blank" rel="noreferrer" className="mt-2 block text-xs text-primary hover:underline">
                            🧾 Print delivery note
                          </a>
                        )}
                        {canManage && column.key === "deliver" && (
                          <div className="mt-2.5 border-t border-border/60 pt-2.5">
                            <ProofOfDelivery quoteId={quote.id} baseVersion={quote.updatedAt.toISOString()} />
                            <p className="mt-1 text-[10px] text-muted-foreground/70">Capture driver, handover checklist &amp; signature.</p>
                            <DirectPhotoUploader kind="delivery" recordId={quote.id} tenantId={quote.tenantId ?? ""} label="Add delivery photos" className="mt-1.5" />
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
      </DesktopOnly>
    </>
  );
}
