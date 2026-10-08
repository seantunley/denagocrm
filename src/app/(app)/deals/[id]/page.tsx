import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import {
  Activity,
  BadgeCheck,
  CalendarClock,
  CarFront,
  Check,
  CircleDollarSign,
  Clock3,
  FileSignature,
  FileText,
  Mail,
  MessageSquareText,
  PackageCheck,
  Phone,
  ReceiptText,
  ShieldCheck,
  Truck,
  UserRound,
  Wrench,
} from "lucide-react";
import { prisma } from "@/lib/db";
import { canAccessLead, hasAnyPermission, requireQuoteReadAccess, requireRoute } from "@/lib/permissions";
import { formatDate, formatDateTime, formatZAR } from "@/lib/format";
import { loadBillToFleet, quoteBillTo } from "@/lib/quoteBillTo";
import { payableTotalCents } from "@/lib/pricing";
import { primaryVehicleLine, showcaseImageRefFor } from "@/lib/docbuilder/vehicleShowcase";
import { storedFileSrc } from "@/lib/storedFileSrc";
import { EntityDetailShell } from "@/components/entity-detail-shell";
import { StatusPill, Surface } from "@/components/visual-system";

function statusTone(status: string): "neutral" | "success" | "warning" | "danger" | "info" {
  if (status === "accepted" || status === "completed" || status === "delivered") return "success";
  if (status === "declined" || status === "cancelled" || status === "rejected") return "danger";
  if (status === "sent" || status === "viewed" || status === "in_progress") return "info";
  if (status === "draft" || status === "pending") return "warning";
  return "neutral";
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <div className="mt-1 truncate text-sm font-semibold text-foreground">{value}</div>
    </div>
  );
}

function ReadinessRow({ done, label, detail }: { done: boolean; label: string; detail?: string }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <span className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border ${done ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300" : "border-amber-400/40 bg-amber-400/10 text-amber-300"}`}>
        {done ? <Check className="size-3" /> : <span className="size-1.5 rounded-full bg-current" />}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {detail && <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>}
      </div>
    </div>
  );
}

function JourneyStep({ label, done, current }: { label: string; done: boolean; current?: boolean }) {
  return (
    <div className="relative flex min-w-0 flex-1 items-center gap-2">
      <span className={`relative z-10 grid size-7 shrink-0 place-items-center rounded-full border ${done ? "border-emerald-400/50 bg-emerald-400/15 text-emerald-300" : current ? "border-primary/60 bg-primary/15 text-primary" : "border-border bg-background text-muted-foreground"}`}>
        {done ? <Check className="size-3.5" /> : <span className="size-1.5 rounded-full bg-current" />}
      </span>
      <span className={`truncate text-xs font-medium ${done ? "text-foreground" : current ? "text-primary" : "text-muted-foreground"}`}>{label}</span>
      <span className="absolute left-7 right-0 top-3.5 h-px bg-border last:hidden" />
    </div>
  );
}

function TimelineItem({
  icon,
  title,
  detail,
  when,
}: {
  icon: ReactNode;
  title: string;
  detail?: string;
  when: Date;
}) {
  return (
    <div className="grid grid-cols-[2rem_minmax(0,1fr)_auto] gap-3 border-b border-border/60 py-3 last:border-0">
      <span className="grid size-8 place-items-center rounded-lg bg-muted/60 text-muted-foreground">{icon}</span>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{title}</p>
        {detail && <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">{detail}</p>}
      </div>
      <span className="whitespace-nowrap text-[11px] text-muted-foreground">{formatDateTime(when)}</span>
    </div>
  );
}

export default async function DealWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The same rule the proxy applies to /deals (routeAccess.ts), then this quote itself.
  await requireRoute("/deals");
  const user = await requireQuoteReadAccess(id);

  const quote = await prisma.quote.findUnique({
    where: { id },
    include: {
      items: { include: { product: true }, orderBy: { sortOrder: "asc" } },
      fees: { orderBy: { sortOrder: "asc" } },
      contact: true,
      lead: {
        include: {
          product: true,
          assignedTo: true,
          activities: { orderBy: { dueDate: "asc" }, take: 20 },
          communications: {
            include: { user: true },
            orderBy: { occurredAt: "desc" },
            take: 16,
          },
        },
      },
      createdBy: true,
      soldStock: { include: { product: true } },
      stockReservations: {
        where: { status: "active" },
        include: { stockUnit: { include: { product: true } }, reservedBy: true },
        orderBy: { reservedAt: "desc" },
      },
    },
  });
  if (!quote || quote.deletedAt) notFound();

  const [documents, signatures] = await Promise.all([
    prisma.document.findMany({
      where: { quoteId: quote.id, deletedAt: null },
      select: { id: true, fileName: true, tag: true, sizeBytes: true, createdAt: true, uploadedBy: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    prisma.signatureRequest.findMany({
      where: { quoteId: quote.id, deletedAt: null },
      select: { id: true, title: true, status: true, sentAt: true, completedAt: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  const total = Math.round(payableTotalCents(quote));
  const depositAmount =
    quote.depositType === "amount"
      ? Math.round((quote.depositValue ?? 0) * 100)
      : quote.depositType === "percent"
        ? Math.round(total * ((quote.depositValue ?? 0) / 100))
        : 0;

  // Who the deal is with: the fleet account when the quote is billed to one, as
  // every quote document states it (quoteBillTo) — not the manager's own name.
  const billTo = quoteBillTo(quote, await loadBillToFleet(prisma, quote.fleetId));
  const customer = billTo.name || "Unlinked customer";
  // The lead's own content — its conversations, activities and source — is shown
  // only to someone who may open that lead. Seeing a quote does not grant its lead.
  const lead =
    quote.lead && (await hasAnyPermission(user, "leads.view_all", "leads.view_owned")) && (await canAccessLead(user, quote.lead.id))
      ? quote.lead
      : null;
  const stock = [
    ...quote.soldStock.map((unit) => ({ ...unit, allocation: "Sold" })),
    ...quote.stockReservations
      .filter((reservation) => !quote.soldStock.some((unit) => unit.id === reservation.stockUnit.id))
      .map((reservation) => ({ ...reservation.stockUnit, allocation: "Reserved" })),
  ];
  const unit = stock[0] ?? null;
  const vehicleLine = primaryVehicleLine(quote.items);
  const vehicleProduct = vehicleLine?.product ?? quote.lead?.product ?? unit?.product ?? null;
  const vehicleColour = vehicleLine?.colorPreference ?? quote.lead?.color ?? unit?.color ?? null;
  const vehicleImage = vehicleProduct
    ? storedFileSrc(showcaseImageRefFor(vehicleProduct, vehicleColour))
    : null;
  const vehicleName = vehicleProduct?.name ?? vehicleLine?.description ?? quote.lead?.title ?? "Vehicle not selected";
  const nextActivity = lead?.activities.find((item) => item.status === "planned") ?? null;
  const accepted = quote.status === "accepted" || Boolean(quote.signedAt);
  const stockReady = stock.length > 0;
  const pdiReady = stockReady && stock.every((item) => item.pdiStatus === "ready_for_delivery" || item.pdiStatus === "passed");
  const deliveryBooked = Boolean(quote.deliveryScheduledFor);
  const delivered = Boolean(quote.deliveredAt);

  const journey = [
    { label: "Quote", done: true },
    { label: "Signed", done: accepted },
    { label: "Deposit", done: Boolean(quote.depositPaidAt) },
    { label: "Stock", done: stockReady },
    { label: "PDI", done: pdiReady },
    { label: "Delivery", done: delivered },
  ];
  const currentIndex = Math.min(journey.findIndex((step) => !step.done), journey.length - 1);

  const commercialLines = quote.items
    .filter((item) => item.selected !== false)
    .map((item) => ({
      id: item.id,
      label: item.description,
      amount: Math.round(item.qty * item.unitPriceCents * (1 - item.discountPct / 100)),
      kind: item.kind,
    }));
  const timeline = [
    ...lead?.communications.map((message) => ({
      key: `comm-${message.id}`,
      when: message.occurredAt,
      icon: message.type === "email" ? <Mail className="size-3.5" /> : <MessageSquareText className="size-3.5" />,
      title: message.subject || `${message.type} ${message.direction || ""}`.trim(),
      detail: message.body,
    })) ?? [],
    ...documents.map((doc) => ({
      key: `doc-${doc.id}`,
      when: doc.createdAt,
      icon: <FileText className="size-3.5" />,
      title: `Document added · ${doc.fileName}`,
      detail: doc.uploadedBy.name,
    })),
    ...signatures.map((request) => ({
      key: `sig-${request.id}`,
      when: request.completedAt ?? request.sentAt ?? request.createdAt,
      icon: <FileSignature className="size-3.5" />,
      title: request.completedAt ? `Signed · ${request.title}` : request.sentAt ? `Signature request sent · ${request.title}` : `Signature request created · ${request.title}`,
      detail: request.status.replaceAll("_", " "),
    })),
    ...(quote.signedAt ? [{ key: "signed", when: quote.signedAt, icon: <BadgeCheck className="size-3.5" />, title: "Quote accepted / signed", detail: quote.signedByName ?? undefined }] : []),
    ...(quote.depositPaidAt ? [{ key: "deposit", when: quote.depositPaidAt, icon: <CircleDollarSign className="size-3.5" />, title: "Deposit marked received", detail: depositAmount ? formatZAR(depositAmount) : undefined }] : []),
    ...(quote.deliveryScheduledFor ? [{ key: "delivery-booked", when: quote.deliveryScheduledFor, icon: <CalendarClock className="size-3.5" />, title: "Delivery scheduled", detail: formatDateTime(quote.deliveryScheduledFor) }] : []),
  ].sort((a, b) => b.when.getTime() - a.when.getTime()).slice(0, 14);

  return (
    <EntityDetailShell
      backHref="/quotes"
      backLabel="Quotes"
      eyebrow="Deal"
      title={`Q-${quote.number} · ${customer}`}
      status={<StatusPill tone={statusTone(quote.status)}>{quote.status}</StatusPill>}
      description={vehicleName}
      meta={`Created ${formatDate(quote.createdAt)}${quote.createdBy ? ` · ${quote.createdBy.name}` : ""}`}
      actions={
        <>
          <Link href={`/quotes?edit=${quote.id}`} className="btn-primary">Edit quote</Link>
          {lead && <Link href={`/leads/${lead.id}?tab=activities&schedule=1`} className="btn-secondary">Add activity</Link>}
          <a href={`/quotes/${quote.id}/print`} target="_blank" rel="noreferrer" className="btn-secondary">Print</a>
        </>
      }
    >
      <div className="space-y-4">
        <Surface className="overflow-hidden">
          <div className="grid min-h-[250px] lg:grid-cols-[minmax(0,1.25fr)_minmax(22rem,.75fr)]">
            <div className="relative overflow-hidden border-b border-border bg-gradient-to-br from-muted/30 via-background to-background lg:border-b-0 lg:border-r">
              {vehicleImage ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element -- authenticated stored-file route */}
                  <img src={vehicleImage} alt={vehicleName} className="absolute inset-0 size-full object-cover opacity-75" />
                  <div className="absolute inset-0 bg-gradient-to-r from-background via-background/45 to-transparent" />
                  <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent" />
                </>
              ) : (
                <div className="absolute inset-0 grid place-items-center text-muted-foreground/15">
                  <CarFront className="size-40" strokeWidth={1} />
                </div>
              )}
              <div className="relative flex h-full min-h-[250px] flex-col justify-end p-5 sm:p-6">
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-primary">Vehicle</p>
                <h2 className="mt-2 max-w-2xl text-2xl font-semibold tracking-tight text-foreground">{vehicleName}</h2>
                <div className="mt-4 grid max-w-2xl grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
                  <Fact label="Colour" value={vehicleColour ?? "—"} />
                  <Fact label="Stock no." value={unit?.stockNumber ?? "Not allocated"} />
                  <Fact label="VIN / Serial" value={unit?.serial ? `••••${unit.serial.slice(-6)}` : "—"} />
                  <Fact label="PDI" value={unit ? unit.pdiStatus.replaceAll("_", " ") : "Pending allocation"} />
                </div>
              </div>
            </div>

            <div className="flex flex-col justify-between p-5 sm:p-6">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Deal value</p>
                <p className="mt-1 text-3xl font-semibold tracking-tight text-foreground">{formatZAR(total)}</p>
                <div className="mt-5 grid grid-cols-2 gap-4 border-t border-border pt-4">
                  <Fact label="Customer" value={customer} />
                  <Fact label="Sales owner" value={quote.lead?.assignedTo?.name ?? quote.createdBy?.name ?? "Unassigned"} />
                  <Fact label="Deposit" value={depositAmount ? formatZAR(depositAmount) : "Not set"} />
                  <Fact label="Next action" value={nextActivity ? formatDateTime(nextActivity.dueDate) : "None planned"} />
                </div>
              </div>
              <div className="mt-5 flex flex-wrap gap-2">
                {quote.contactId && <Link href={`/contacts/${quote.contactId}`} className="btn-secondary btn-sm"><UserRound className="size-4" />Customer</Link>}
                {lead && <Link href={`/leads/${lead.id}`} className="btn-secondary btn-sm"><Activity className="size-4" />Lead</Link>}
                {quote.status === "accepted" && <Link href="/deliveries" className="btn-secondary btn-sm"><Truck className="size-4" />Delivery board</Link>}
              </div>
            </div>
          </div>

          <div className="border-t border-border bg-muted/15 px-5 py-4 sm:px-6">
            <div className="flex gap-3 overflow-x-auto pb-1">
              {journey.map((step, index) => (
                <JourneyStep key={step.label} label={step.label} done={step.done} current={index === currentIndex && !step.done} />
              ))}
            </div>
          </div>
        </Surface>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(19rem,.55fr)]">
          <div className="space-y-4">
            <Surface className="p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Commercials</p>
                  <h2 className="mt-1 text-base font-semibold">Deal sheet</h2>
                </div>
                <CircleDollarSign className="size-5 text-muted-foreground" />
              </div>
              <div className="mt-4 divide-y divide-border/70">
                {commercialLines.map((line) => (
                  <div key={line.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{line.label}</p>
                      <p className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">{line.kind.replaceAll("_", " ")}</p>
                    </div>
                    <p className="text-sm font-semibold tabular-nums">{formatZAR(line.amount)}</p>
                  </div>
                ))}
                {quote.fees.map((fee) => (
                  <div key={fee.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 py-3">
                    <div>
                      <p className="text-sm font-medium">{fee.label}</p>
                      <p className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">Fee</p>
                    </div>
                    <p className="text-sm font-semibold tabular-nums">{formatZAR(fee.amountCents)}</p>
                  </div>
                ))}
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 py-4">
                  <div>
                    <p className="font-semibold">Deal total</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{quote.depositPaidAt ? "Deposit received" : depositAmount ? `Deposit expected · ${formatZAR(depositAmount)}` : "No deposit terms set"}</p>
                  </div>
                  <p className="text-lg font-semibold tabular-nums">{formatZAR(total)}</p>
                </div>
              </div>
            </Surface>

            <Surface className="p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Activity</p>
                  <h2 className="mt-1 text-base font-semibold">Deal timeline</h2>
                </div>
                {lead && <Link href={`/leads/${lead.id}?tab=comms`} className="text-xs font-medium text-primary hover:underline">Full timeline</Link>}
              </div>
              <div className="mt-3">
                {timeline.length ? timeline.map((event) => (
                  <TimelineItem key={event.key} icon={event.icon} title={event.title} detail={event.detail} when={event.when} />
                )) : (
                  <div className="py-8 text-center text-sm text-muted-foreground">No deal activity recorded yet.</div>
                )}
              </div>
            </Surface>

            {stock.length > 0 && (
              <Surface className="p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Allocated stock</p>
                    <h2 className="mt-1 text-base font-semibold">{stock.length} physical unit{stock.length === 1 ? "" : "s"}</h2>
                  </div>
                  <PackageCheck className="size-5 text-muted-foreground" />
                </div>
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  {stock.map((item) => (
                    <Link key={item.id} href={`/stock/${item.id}`} className="rounded-xl border border-border bg-muted/20 p-3.5 hover:bg-muted/35">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold">{item.product.name}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{[item.color, item.stockNumber, item.location].filter(Boolean).join(" · ")}</p>
                        </div>
                        <StatusPill tone={item.status === "sold" ? "success" : "info"}>{item.allocation}</StatusPill>
                      </div>
                      <div className="mt-3 flex items-center gap-2 text-xs">
                        <Wrench className="size-3.5 text-muted-foreground" />
                        <span className="text-muted-foreground">PDI</span>
                        <span className="font-medium">{item.pdiStatus.replaceAll("_", " ")}</span>
                      </div>
                    </Link>
                  ))}
                </div>
              </Surface>
            )}
          </div>

          <aside className="space-y-4">
            <Surface className="p-5">
              <div className="flex items-center gap-2">
                <ShieldCheck className="size-5 text-primary" />
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Readiness</p>
                  <h2 className="mt-0.5 text-base font-semibold">Ready to deliver?</h2>
                </div>
              </div>
              <div className="mt-3 divide-y divide-border/60">
                <ReadinessRow done={accepted} label="Agreement accepted" detail={quote.signedAt ? formatDateTime(quote.signedAt) : "Customer acceptance outstanding"} />
                <ReadinessRow done={Boolean(quote.depositPaidAt)} label="Deposit received" detail={quote.depositPaidAt ? formatDateTime(quote.depositPaidAt) : depositAmount ? `Waiting for ${formatZAR(depositAmount)}` : "No deposit receipt recorded"} />
                <ReadinessRow done={stockReady} label="Stock allocated" detail={stockReady ? stock.map((item) => item.stockNumber ?? item.product.name).join(", ") : "No physical unit assigned"} />
                <ReadinessRow done={pdiReady} label="PDI complete" detail={stockReady ? (pdiReady ? "Allocated stock ready for delivery" : "Workshop preparation still outstanding") : "Requires stock allocation first"} />
                <ReadinessRow done={deliveryBooked} label="Delivery booked" detail={deliveryBooked ? formatDateTime(quote.deliveryScheduledFor) : "No delivery date scheduled"} />
              </div>
              {quote.status === "accepted" && <Link href="/deliveries" className="btn-primary btn-sm mt-4 w-full"><Truck className="size-4" />Open fulfilment</Link>}
            </Surface>

            <Surface className="p-5">
              <div className="flex items-center gap-2">
                <UserRound className="size-5 text-muted-foreground" />
                <h2 className="text-sm font-semibold">Customer</h2>
              </div>
              <div className="mt-4">
                <p className="text-base font-semibold">{customer}</p>
                {billTo.attention && <p className="mt-0.5 text-xs text-muted-foreground">Attention: {billTo.attention}</p>}
                <div className="mt-3 space-y-2 text-sm">
                  <p className="flex items-center gap-2 text-muted-foreground"><Mail className="size-3.5" /><span className="truncate">{billTo.email || "No email"}</span></p>
                  <p className="flex items-center gap-2 text-muted-foreground"><Phone className="size-3.5" /><span>{billTo.phone || "No phone"}</span></p>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-4">
                <Fact label="Source" value={lead?.source ?? "—"} />
                <Fact label="Owner" value={quote.lead?.assignedTo?.name ?? quote.createdBy?.name ?? "—"} />
              </div>
            </Surface>

            <Surface className="p-5">
              <div className="flex items-center gap-2">
                <Clock3 className="size-5 text-muted-foreground" />
                <h2 className="text-sm font-semibold">Next action</h2>
              </div>
              {nextActivity ? (
                <div className="mt-4">
                  <p className="text-sm font-semibold">{nextActivity.summary}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{nextActivity.type}{nextActivity.location ? ` · ${nextActivity.location}` : ""}</p>
                  <p className="mt-3 text-xs font-medium text-primary">{formatDateTime(nextActivity.dueDate)}</p>
                </div>
              ) : (
                <p className="mt-4 text-sm text-muted-foreground">Nothing scheduled.</p>
              )}
              {lead && <Link href={`/leads/${lead.id}?tab=activities&schedule=1`} className="btn-secondary btn-sm mt-4 w-full">Schedule activity</Link>}
            </Surface>

            <Surface className="p-5">
              <div className="flex items-center gap-2">
                <FileText className="size-5 text-muted-foreground" />
                <h2 className="text-sm font-semibold">Deal file</h2>
              </div>
              <div className="mt-3 space-y-1.5">
                <a href={`/quotes/${quote.id}/print`} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-muted/40"><FileText className="size-4 text-muted-foreground" />Quotation</a>
                {quote.status === "accepted" && <>
                  <a href={`/quotes/${quote.id}/invoice`} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-muted/40"><ReceiptText className="size-4 text-muted-foreground" />Invoice</a>
                  <a href={`/quotes/${quote.id}/agreement`} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-muted/40"><FileSignature className="size-4 text-muted-foreground" />Sales agreement</a>
                  <a href={`/quotes/${quote.id}/delivery-note`} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-muted/40"><Truck className="size-4 text-muted-foreground" />Delivery note</a>
                </>}
              </div>
              <div className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
                {documents.length} filed document{documents.length === 1 ? "" : "s"} · {signatures.length} signature request{signatures.length === 1 ? "" : "s"}
              </div>
            </Surface>

            {!quote.invoicedAt && (
              <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-4 text-xs leading-5 text-amber-100/80">
                <strong className="text-amber-200">Financial ledger not yet available.</strong> This deal view shows quote value, deposit terms and fulfilment markers only; balances and payments remain part of the upcoming Deal Financials module.
              </div>
            )}
          </aside>
        </div>
      </div>
    </EntityDetailShell>
  );
}
