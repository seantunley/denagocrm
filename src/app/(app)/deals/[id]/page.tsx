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
  X,
} from "lucide-react";
import { prisma } from "@/lib/db";
import { canAccessContact, canAccessLead, hasAnyPermission, requireQuoteReadAccess, requireRoute } from "@/lib/permissions";
import { formatDate, formatDateTime, formatZAR } from "@/lib/format";
import { loadBillToFleet, quoteBillTo } from "@/lib/quoteBillTo";
import { payableTotalCents } from "@/lib/pricing";
import { isStatementInvoice } from "@/lib/accountStatement";
import { getRegionalSettings } from "@/lib/settings";
import DocumentsPanel from "@/components/DocumentsPanel";
import DealFileSearch from "@/components/deals/DealFileSearch";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { loadDealFile } from "@/lib/dealFileData";
import DealFileZipButton from "@/components/deals/DealFileZipButton";
import { vendorKindLabel } from "@/lib/vendors";
import { addDealVendor, removeDealVendor } from "@/app/actions/vendors";
import { withCurrency } from "@/lib/currencyRules";
import DealPayments from "@/components/deals/DealPayments";
import { primaryVehicleLine, showcaseImageRefFor } from "@/lib/docbuilder/vehicleShowcase";
import { storedFileSrc } from "@/lib/storedFileSrc";
import { getRecordLabels } from "@/lib/recordLabelsServer";
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
  const labels = await getRecordLabels();

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

  // THE DEAL FILE (Sean, 2026-11-09): one file for the whole deal — every quote on the lead, revisions
  // included — not just this quote's. Only the quotes this person may open; a quote with no lead is its own deal.
  // The same loader builds the ZIP download (api/deals/[id]/file-zip), so the two can't disagree.
  const { tenantId, suppliersOn, dealQuotes, documents, signatures, declaredVendors, checklist } = await loadDealFile(quote, user);
  const [canUpload, vendors] = await Promise.all([
    hasAnyPermission(user, "documents.upload"),
    suppliersOn ? prisma.vendor.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : [],
  ]);
  const checklistDone = checklist.filter((item) => item.done).length;
  const quoteGroups = dealQuotes.map((dealQuote) => ({
    id: dealQuote.id,
    number: dealQuote.number,
    status: dealQuote.status,
    signed: dealQuote.signedAt != null,
    superseded: dealQuote.supersededAt != null,
    totalCents: payableTotalCents(dealQuote),
    currency: dealQuote.currency,
    createdAt: dealQuote.createdAt,
    documents: documents.filter((doc) => doc.quoteId === dealQuote.id),
  }));
  const currentQuotes = dealQuotes.filter((dealQuote) => dealQuote.supersededAt == null);
  // Upload goes on this quote, or the deal's current one when this one was revised.
  const uploadQuoteId = currentQuotes.some((dealQuote) => dealQuote.id === quote.id) ? quote.id : currentQuotes[0]?.id;

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

  // MONEY RECEIVED — real QuotePayment rows in the quote's own workspace, plus
  // the deposit recorded on the deliveries board. Only an accepted quote is an
  // invoice, so only it has payments.
  const invoice = isStatementInvoice(quote);
  const payments =
    invoice && quote.tenantId
      ? await prisma.quotePayment.findMany({ where: { quoteId: quote.id, tenantId: quote.tenantId }, orderBy: { receivedAt: "asc" } })
      : [];
  const canRecordPayments = invoice && (await hasAnyPermission(user, "deliveries.manage"));
  // The statement this invoice appears on — the fleet's when billed to one — and
  // only as a link the viewer can actually open (the page re-checks both).
  // The statement in THIS deal's currency (multicurrency module): a statement covers one currency.
  const statementCurrency = quote.currency ? `?currency=${encodeURIComponent(quote.currency)}` : "";
  const statementHref = !invoice
    ? null
    : billTo.isFleet && quote.fleetId
      ? (await hasAnyPermission(user, "fleets.view", "fleets.manage")) ? `/fleets/${quote.fleetId}/statement${statementCurrency}` : null
      : quote.contactId && (await canAccessContact(user, quote.contactId))
        ? `/contacts/${quote.contactId}/statement${statementCurrency}`
        : null;
  const { timeZone } = await getRegionalSettings();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
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
    { label: "Accepted", done: accepted },
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
  // Every amount on this page is the quote's — in ITS currency (multicurrency module; null = the base).
  const moneyFmt = withCurrency(await getRegionalSettings(), quote.currency);
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
    ...(quote.depositPaidAt ? [{ key: "deposit", when: quote.depositPaidAt, icon: <CircleDollarSign className="size-3.5" />, title: "Deposit marked received", detail: depositAmount ? formatZAR(depositAmount, moneyFmt) : undefined }] : []),
    ...(quote.deliveryScheduledFor ? [{ key: "delivery-booked", when: quote.deliveryScheduledFor, icon: <CalendarClock className="size-3.5" />, title: "Delivery scheduled", detail: formatDateTime(quote.deliveryScheduledFor) }] : []),
  ].sort((a, b) => b.when.getTime() - a.when.getTime()).slice(0, 14);

  return (
    <EntityDetailShell
      backHref="/quotes"
      backLabel="Quotes"
      eyebrow={labels.deal.one}
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
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">{labels.deal.one} value</p>
                <p className="mt-1 text-3xl font-semibold tracking-tight text-foreground">{formatZAR(total, moneyFmt)}</p>
                <div className="mt-5 grid grid-cols-2 gap-4 border-t border-border pt-4">
                  <Fact label="Customer" value={customer} />
                  <Fact label="Sales owner" value={quote.lead?.assignedTo?.name ?? quote.createdBy?.name ?? "Unassigned"} />
                  <Fact label="Deposit" value={depositAmount ? formatZAR(depositAmount, moneyFmt) : "Not set"} />
                  <Fact label="Next action" value={nextActivity ? formatDateTime(nextActivity.dueDate) : "None planned"} />
                </div>
              </div>
              <div className="mt-5 flex flex-wrap gap-2">
                {quote.contactId && <Link href={`/contacts/${quote.contactId}`} className="btn-secondary btn-sm"><UserRound className="size-4" />Customer</Link>}
                {lead && <Link href={`/leads/${lead.id}`} className="btn-secondary btn-sm"><Activity className="size-4" />{labels.lead.one}</Link>}
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
                  <h2 className="mt-1 text-base font-semibold">{labels.deal.one} sheet</h2>
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
                    <p className="text-sm font-semibold tabular-nums">{formatZAR(line.amount, moneyFmt)}</p>
                  </div>
                ))}
                {quote.fees.map((fee) => (
                  <div key={fee.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 py-3">
                    <div>
                      <p className="text-sm font-medium">{fee.label}</p>
                      <p className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">Fee</p>
                    </div>
                    <p className="text-sm font-semibold tabular-nums">{formatZAR(fee.amountCents, moneyFmt)}</p>
                  </div>
                ))}
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 py-4">
                  <div>
                    <p className="font-semibold">{labels.deal.one} total</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{quote.depositPaidAt ? "Deposit received" : depositAmount ? `Deposit expected · ${formatZAR(depositAmount, moneyFmt)}` : "No deposit terms set"}</p>
                  </div>
                  <p className="text-lg font-semibold tabular-nums">{formatZAR(total, moneyFmt)}</p>
                </div>
              </div>
            </Surface>

            {invoice && (
              <DealPayments quote={quote} payments={payments} canRecord={canRecordPayments} statementHref={statementHref} today={today} moneyFmt={moneyFmt} />
            )}

            <div id="deal-file" className="scroll-mt-20 space-y-3">
              <Surface className="p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Everything on file</p>
                    <h2 className="mt-1 text-base font-semibold">{labels.deal.one} file</h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {documents.length} filed document{documents.length === 1 ? "" : "s"} across {dealQuotes.length} quote{dealQuotes.length === 1 ? "" : "s"} · {checklistDone} of {checklist.length} required on file
                    </p>
                  </div>
                  <div className="flex flex-wrap items-start gap-2">
                    <DealFileSearch targetId="deal-file" />
                    <DealFileZipButton quoteId={quote.id} />
                  </div>
                </div>
                {/* Declared up front, so the checklist asks for each supplier's papers before any arrive. Suppliers module only. */}
                {suppliersOn && <>
                <p className="mt-4 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Suppliers on this deal</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {declaredVendors.length === 0 && <span className="text-xs text-muted-foreground">None yet — add the OEM, the delivery company and anyone else you pay on this deal.</span>}
                  {declaredVendors.map((vendor) => (
                    <span key={vendor.id} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/30 py-1 pl-3 pr-1.5 text-xs">
                      <span className="font-medium">{vendor.name}</span>
                      <span className="text-muted-foreground">{vendorKindLabel(vendor.kind)}</span>
                      {canUpload && (
                        <SaveForm action={removeDealVendor.bind(null, quote.id, vendor.id)} success={`${vendor.name} removed`}>
                          <SaveButton className="grid size-5 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground" pendingLabel="…" aria-label={`Take ${vendor.name} off this deal`}>
                            <X className="size-3" />
                          </SaveButton>
                        </SaveForm>
                      )}
                    </span>
                  ))}
                  {canUpload && vendors.some((vendor) => !declaredVendors.some((on) => on.id === vendor.id)) && (
                    <SaveForm action={addDealVendor.bind(null, quote.id)} success="Supplier added" className="flex items-center gap-1.5">
                      <select name="vendorId" required defaultValue="" className="input h-8 w-48 text-xs" aria-label="Supplier to add">
                        <option value="" disabled>Add a supplier…</option>
                        {vendors.filter((vendor) => !declaredVendors.some((on) => on.id === vendor.id)).map((vendor) => (
                          <option key={vendor.id} value={vendor.id}>{vendor.name}</option>
                        ))}
                      </select>
                      <SaveButton className="btn-secondary btn-sm">Add</SaveButton>
                    </SaveForm>
                  )}
                  {canUpload && vendors.length === 0 && <span className="text-xs text-muted-foreground">An owner adds suppliers in Settings → Suppliers.</span>}
                </div>
                </>}
                <p className="mt-4 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">From the CRM</p>
                <ul className="mt-1 divide-y divide-border/60">
                  {currentQuotes.flatMap((dealQuote) => [
                    { key: `${dealQuote.id}-q`, href: `/quotes/${dealQuote.id}/print`, icon: <FileText className="size-4 text-muted-foreground" />, label: `Quotation Q-${dealQuote.number}` },
                    ...(dealQuote.status === "accepted"
                      ? [
                          { key: `${dealQuote.id}-i`, href: `/quotes/${dealQuote.id}/invoice`, icon: <ReceiptText className="size-4 text-muted-foreground" />, label: `Invoice Q-${dealQuote.number}` },
                          { key: `${dealQuote.id}-a`, href: `/quotes/${dealQuote.id}/agreement`, icon: <FileSignature className="size-4 text-muted-foreground" />, label: `Sales agreement Q-${dealQuote.number}` },
                          { key: `${dealQuote.id}-d`, href: `/quotes/${dealQuote.id}/delivery-note`, icon: <Truck className="size-4 text-muted-foreground" />, label: `Delivery note Q-${dealQuote.number}` },
                        ]
                      : []),
                  ]).map((row) => (
                    <li key={row.key} data-search={row.label.toLowerCase()}>
                      <a href={row.href} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg px-1 py-2 text-sm hover:bg-muted/40">{row.icon}{row.label}</a>
                    </li>
                  ))}
                  {signatures.map((request) => (
                    <li key={request.id} data-search={`${request.title} signature ${request.status}`.toLowerCase()}>
                      <Link href={`/signatures/${request.id}`} className="flex items-center gap-2 rounded-lg px-1 py-2 text-sm hover:bg-muted/40">
                        <FileSignature className="size-4 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{request.title}</span>
                        <span className="text-xs text-muted-foreground">{request.status.replaceAll("_", " ")}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Surface>
              <DocumentsPanel
                title="Filed documents"
                documents={[]}
                quoteGroups={quoteGroups}
                defaultQuoteId={uploadQuoteId}
                hideUpload={!canUpload || !uploadQuoteId}
                revalidate={`/deals/${quote.id}`}
              />
            </div>

            <Surface className="p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Activity</p>
                  <h2 className="mt-1 text-base font-semibold">{labels.deal.one} timeline</h2>
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
                <ReadinessRow done={accepted} label="Agreement accepted" detail={quote.signedAt ? `Signed ${formatDateTime(quote.signedAt)}` : accepted ? "Marked accepted — not signed online" : "Customer acceptance outstanding"} />
                <ReadinessRow done={Boolean(quote.depositPaidAt)} label="Deposit received" detail={quote.depositPaidAt ? formatDateTime(quote.depositPaidAt) : depositAmount ? `Waiting for ${formatZAR(depositAmount, moneyFmt)}` : "No deposit receipt recorded"} />
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
                <h2 className="text-sm font-semibold">{labels.deal.one} file</h2>
                <StatusPill tone={checklistDone === checklist.length ? "success" : "warning"}>{checklistDone} of {checklist.length}</StatusPill>
              </div>
              <div className="mt-3 divide-y divide-border/60">
                {checklist.map((item) => (
                  <ReadinessRow key={item.key} done={item.done} label={item.label} detail={item.detail} />
                ))}
              </div>
              <a href="#deal-file" className="btn-secondary btn-sm mt-4 w-full"><FileText className="size-4" />Open the file</a>
            </Surface>

          </aside>
        </div>
      </div>
    </EntityDetailShell>
  );
}
