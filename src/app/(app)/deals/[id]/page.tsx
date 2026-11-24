import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { notFound } from "next/navigation";
import {
  Activity,
  BadgeCheck,
  CalendarClock,
  CarFront,
  Check,
  CircleDollarSign,
  FileSignature,
  FileText,
  Mail,
  MessageSquareText,
  Minus,
  PackageCheck,
  Phone,
  ReceiptText,
  Truck,
  UserRound,
  Wrench,
  X,
} from "lucide-react";
import { prisma } from "@/lib/db";
import { canAccessContact, canAccessLead, hasAnyPermission, hasPermission, requireQuoteReadAccess, requireRoute } from "@/lib/permissions";
import { dealFinanceHouses, loadDealFinance } from "@/lib/dealFinance";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { financeBlocksDelivery, quoteInPlay } from "@/lib/dealFinanceRules";
import DealFinancePanel from "@/components/deals/DealFinancePanel";
import DealStandsPanel from "@/components/deals/DealStandsPanel";
import DealNextStepCard from "@/components/deals/DealNextStepCard";
import MarkAcceptedButton from "@/components/deals/MarkAcceptedButton";
import OpenRecordLink from "@/components/records/OpenRecordLink";
import RecordDrawer from "@/components/records/RecordDrawer";
import { dealStand, nextStepWarning } from "@/lib/dealStand";
import { dealMilestones, dealProgress, pdiReady as dealPdiReady, type BlockerKey } from "@/lib/dealMilestones";
import { getDealLifecycle } from "@/lib/dealLifecycleServer";
import { readinessLabels } from "@/lib/dealLifecycle";
import { formatDate, formatDateTime, formatZAR } from "@/lib/format";
import { loadBillToFleet, quoteBillTo } from "@/lib/quoteBillTo";
import { payableTotalCents } from "@/lib/pricing";
import { isStatementInvoice, receivedCents } from "@/lib/accountStatement";
import { getRegionalSettings } from "@/lib/settings";
import DocumentsPanel from "@/components/DocumentsPanel";
import DealFileSearch from "@/components/deals/DealFileSearch";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { loadDealFile } from "@/lib/dealFileData";
import DealFileZipButton from "@/components/deals/DealFileZipButton";
import { vendorKindLabel } from "@/lib/vendors";
import { addDealVendor, removeDealVendor } from "@/app/actions/vendors";
import { recallDocumentRequest } from "@/app/actions/documentRequests";
import DocumentRequestButton from "@/components/deals/DocumentRequestButton";
import { documentRequestState } from "@/lib/documentRequestRules";
import { withCurrency } from "@/lib/currencyRules";
import DealPayments from "@/components/deals/DealPayments";
import { paymentsComeFromXero } from "@/lib/xero";
import { xeroOwnsPayments } from "@/lib/xeroInvoice";
import { primaryVehicleLine, showcaseImageRefFor } from "@/lib/docbuilder/vehicleShowcase";
import { storedFileSrc } from "@/lib/storedFileSrc";
import { getRecordLabels } from "@/lib/recordLabelsServer";
import { EntityDetailShell } from "@/components/entity-detail-shell";
import { StatusPill, Surface } from "@/components/visual-system";

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <div className="mt-1 truncate text-sm font-semibold text-foreground">{value}</div>
    </div>
  );
}

function ReadinessRow({ done, skipped, label, detail, action }: { done: boolean; skipped?: boolean; label: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <span className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border ${done ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300" : skipped ? "border-dashed border-border text-muted-foreground/60" : "border-amber-400/40 bg-amber-400/10 text-amber-300"}`}>
        {done ? <Check className="size-3" /> : skipped ? <Minus className="size-3" /> : <span className="size-1.5 rounded-full bg-current" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {detail && <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>}
        {action}
      </div>
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
    suppliersOn ? prisma.vendor.findMany({ where: { tenantId, deletedAt: null }, select: { id: true, name: true, email: true }, orderBy: { name: "asc" } }) : [],
  ]);
  const dealQuoteIds = dealQuotes.map((dealQuote) => dealQuote.id);
  const checklistDone = checklist.filter((item) => item.done).length;
  // Papers asked of suppliers through an upload link (lib/documentRequests.ts), for every quote on the deal.
  const requests = suppliersOn
    ? await prisma.documentRequest.findMany({
        where: { tenantId, quoteId: { in: dealQuoteIds } },
        select: { id: true, quoteId: true, vendorId: true, documentType: true, sentTo: true, createdAt: true, expiresAt: true, revokedAt: true, fulfilledAt: true },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const requestNow = new Date();
  /** The checklist line's supplier and paper, when it can be asked for. */
  const askable = (item: (typeof checklist)[number]) => {
    if (item.done || !suppliersOn || !canUpload || !item.supplier?.vendorId) return null;
    const vendor = vendors.find((v) => v.id === item.supplier!.vendorId);
    return vendor ? { vendor, documentType: item.supplier.documentType } : null;
  };
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
    // Handover photos are read by DocumentsPanel itself, for every page that lists quotes.
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
  // Payments come from Xero (2026-11-11): this invoice is in Xero, so its forms give way to Refresh.
  const paymentsFromXeroHere = Boolean(quote.tenantId) && Boolean(xeroOwnsPayments(quote, await paymentsComeFromXero(quote.tenantId!)));
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
  // Finance through an outside finance house — THIS quote's (finance is per quote), for someone who may open the lead.
  const [finance, financeHouses, canEditFinance] = lead && (await isModuleEnabled("finance"))
    ? await Promise.all([
        loadDealFinance(tenantId, quote.id),
        dealFinanceHouses(tenantId, lead.id),
        hasPermission(user, "leads.edit"),
      ])
    : [null, [], false];
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
  const deliveryBooked = Boolean(quote.deliveryScheduledFor);
  const delivered = Boolean(quote.deliveredAt);

  // Where the deal stands, by the shared rules (dealMilestones.ts) the Deals Centre uses too.
  const facts = {
    accepted,
    depositCents: depositAmount,
    depositPaid: Boolean(quote.depositPaidAt),
    stock,
    deliveryBooked,
    delivered,
    financeHolds: finance ? financeBlocksDelivery(finance.status) : false,
  };
  const pdiReady = dealPdiReady(stock);
  // The workspace's lifecycle (brief §5): its step names, and which steps its deals have.
  const lifecycle = await getDealLifecycle();
  const journey = dealMilestones(facts, lifecycle);
  const ready = readinessLabels(lifecycle);
  const progress = dealProgress(journey);
  // Each step's button goes where it is done — only for someone allowed to do it there.
  const [canManageDeliveries, canSeeStock, canChangeStatus, canManageActivities] = await Promise.all([
    hasAnyPermission(user, "deliveries.manage"),
    hasAnyPermission(user, "stock.view", "stock.manage"),
    hasPermission(user, "quotes.change_status"),
    hasPermission(user, "activities.manage"),
  ]);
  const regional = await getRegionalSettings();
  const date = (d: Date) => formatDate(d, regional);
  // ONE account of where the deal stands (lib/dealStand.ts): the headline, the steps panel and the main button all read it.
  const stand = dealStand({
    journey,
    status: quote.status,
    accepted,
    delivered,
    financeHolds: facts.financeHolds,
    sentAt: quote.sentAt,
    viewedAt: quote.viewedAt,
    signedAt: quote.signedAt,
    depositPaid: Boolean(quote.depositPaidAt),
    depositLabel: depositAmount ? formatZAR(depositAmount, withCurrency(regional, quote.currency)) : null,
    stockCount: stock.length,
    pdiReady,
    deliveryAt: quote.deliveryScheduledFor,
    deliveredAt: quote.deliveredAt,
    customer,
    readyTitle: ready.title,
    date,
  });
  const nowStep = stand.steps.find((step) => step.state === "now") ?? null;
  const stepLinks: Partial<Record<BlockerKey, { label: string; href: string }>> = {
    ...(lead ? {} : { accept: { label: "Open quote", href: `/quotes/${quote.id}` } }),
    ...(canManageDeliveries ? { deposit: { label: "Record deposit", href: "/deliveries" }, delivery: { label: "Book delivery", href: "/deliveries" } } : {}),
    ...(finance ? { finance: { label: "Finance", href: "#finance" } } : {}),
    ...(canSeeStock ? { stock: { label: "Allocate", href: "/stock" } } : {}),
    ...(canSeeStock && unit ? { pdi: { label: "Open unit", href: `/stock/${unit.id}` } } : {}),
  };
  // Chasing the customer happens beside the page, in the record drawer's composer (log a call, WhatsApp, email).
  const chase = (className: string, label: string) =>
    lead ? <OpenRecordLink record={{ type: "lead", id: lead.id }} className={className}>{label}</OpenRecordLink> : null;
  const stepButtons: Partial<Record<BlockerKey, ReactNode>> = Object.fromEntries(
    Object.entries(stepLinks).map(([key, link]) => [key, <Link key={key} href={link!.href} className="btn-secondary btn-sm">{link!.label}</Link>]),
  );
  if (lead) stepButtons.accept = chase("btn-primary btn-sm", "Chase");
  // The header's main button: whatever the step the deal is on needs, else editing the quote.
  const primaryAction =
    quote.status === "draft"
      ? <Link href={`/quotes?edit=${quote.id}`} className="btn-primary">Finish and send the quote</Link>
      : nowStep?.action === "accept" && lead
        ? chase("btn-primary", "Chase the customer")
        : nowStep?.action && stepLinks[nowStep.action]
          ? <Link href={stepLinks[nowStep.action]!.href} className="btn-primary">{stepLinks[nowStep.action]!.label}</Link>
          : null;
  const warning = nextStepWarning({
    nextDue: nextActivity?.dueDate ?? null,
    validUntil: quote.validUntil,
    accepted,
    delivered,
    closed: quote.status === "declined" || quote.status === "cancelled",
    now: requestNow,
    date,
  });
  const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(requestNow.getTime() + 24 * 60 * 60 * 1000));
  const nextStepCard = lead ? (
    <DealNextStepCard
      next={nextActivity ? { id: nextActivity.id, summary: nextActivity.summary, type: nextActivity.type, when: formatDateTime(nextActivity.dueDate) } : null}
      warning={warning}
      tomorrow={tomorrow}
      canManage={canManageActivities}
      scheduleHref={`/leads/${lead.id}?tab=activities&schedule=1`}
    />
  ) : null;

  const commercialLines = quote.items
    .filter((item) => item.selected !== false)
    .map((item) => ({
      id: item.id,
      label: item.description,
      amount: Math.round(item.qty * item.unitPriceCents * (1 - item.discountPct / 100)),
      kind: item.kind,
    }));
  // Every amount on this page is the quote's — in ITS currency (multicurrency module; null = the base).
  const moneyFmt = withCurrency(regional, quote.currency);
  // What has come in: an accepted quote's real payments (the statement's own rule); nothing before it is an invoice.
  const paid = invoice ? receivedCents(quote, payments) : 0;
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
      status={<StatusPill tone={stand.headline.tone}>{stand.headline.text}</StatusPill>}
      description={[vehicleName, vehicleColour, stand.headline.detail].filter(Boolean).join(" · ")}
      meta={`Created ${formatDate(quote.createdAt)}${quote.createdBy ? ` · ${quote.createdBy.name}` : ""} · Owner ${quote.lead?.assignedTo?.name ?? quote.createdBy?.name ?? "unassigned"}`}
      actions={
        <>
          {primaryAction}
          {canChangeStatus && quote.status === "sent" && !quote.signedAt && <MarkAcceptedButton quoteId={quote.id} number={quote.number} />}
          <Link href={`/quotes?edit=${quote.id}`} className={primaryAction ? "btn-secondary" : "btn-primary"}>Edit quote</Link>
          <a href={`/quotes/${quote.id}/print`} target="_blank" rel="noreferrer" className="btn-secondary">Print</a>
        </>
      }
    >
      <div className="space-y-4">
        {/* Who, how much, and one click to reach them. */}
        <Surface className="flex flex-wrap items-center gap-x-8 gap-y-4 p-5">
          <div className="min-w-[12rem]">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{labels.deal.one} value</p>
            <p className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">{formatZAR(total, moneyFmt)}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {invoice ? `Paid ${formatZAR(paid, moneyFmt)} · owed ${formatZAR(Math.max(0, total - paid), moneyFmt)}` : depositAmount ? `Deposit asked · ${formatZAR(depositAmount, moneyFmt)}` : "No deposit asked · nothing owed until accepted"}
            </p>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Customer</p>
            <p className="mt-1 truncate text-base font-semibold">{customer}</p>
            {billTo.attention && <p className="text-xs text-muted-foreground">Attention: {billTo.attention}</p>}
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{[billTo.phone, billTo.email].filter(Boolean).join(" · ") || "No phone or email"}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {billTo.phone && <a href={`tel:${billTo.phone}`} className="btn-secondary btn-sm"><Phone className="size-4" />Call</a>}
            {chase("btn-secondary btn-sm", "Log a call or message")}
            {quote.contactId && <Link href={`/contacts/${quote.contactId}`} className="btn-secondary btn-sm"><UserRound className="size-4" />Customer</Link>}
            {lead && <Link href={`/leads/${lead.id}`} className="btn-secondary btn-sm"><Activity className="size-4" />{labels.lead.one}</Link>}
          </div>
        </Surface>

        <DealStandsPanel steps={stand.steps} progress={progress} buttons={stepButtons} />
        {/* On a phone or narrow screen the next step comes straight after where the deal stands; on a wide one it sits in the side column. */}
        {nextStepCard && <div className="xl:hidden">{nextStepCard}</div>}

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
              </div>
              {/* Total, what has come in, and what is still owed — in the deal's own currency, never mixed. */}
              <div className="mt-2 grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl bg-muted/30 px-4 py-3">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{labels.deal.one} total</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">{formatZAR(total, moneyFmt)}</p>
                </div>
                <div className="rounded-xl bg-muted/30 px-4 py-3">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Paid</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">{formatZAR(paid, moneyFmt)}</p>
                </div>
                <div className="rounded-xl bg-muted/30 px-4 py-3">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{invoice ? "Owed" : "Owed once accepted"}</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">{formatZAR(Math.max(0, total - paid), moneyFmt)}</p>
                </div>
              </div>
            </Surface>

            {lead && (finance || financeHouses.length > 0) && (
              <div id="finance" className="scroll-mt-20">
                <DealFinancePanel quote={{ id: quote.id, number: quote.number, inPlay: quoteInPlay(quote) }} finance={finance} financeHouses={financeHouses} canEdit={canEditFinance} now={requestNow} />
              </div>
            )}

            {invoice && (
              <DealPayments quote={quote} payments={payments} canRecord={canRecordPayments} fromXero={paymentsFromXeroHere} statementHref={statementHref} today={today} moneyFmt={moneyFmt} />
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
            {nextStepCard && <div className="hidden xl:block">{nextStepCard}</div>}

            {/* The vehicle, compact: what it is and where its unit stands. The photo is a thumbnail, not the page. */}
            <Surface className="p-5" aria-label="Vehicle">
              <div className="flex gap-4">
                <div className="grid h-20 w-28 shrink-0 place-items-center overflow-hidden rounded-xl bg-muted/40 text-muted-foreground/40">
                  {vehicleImage ? (
                    // eslint-disable-next-line @next/next/no-img-element -- authenticated stored-file route
                    <img src={vehicleImage} alt={vehicleName} className="size-full object-cover" />
                  ) : (
                    <CarFront className="size-10" strokeWidth={1.5} aria-hidden="true" />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Vehicle</p>
                  <p className="mt-1 truncate text-sm font-semibold">{vehicleName}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{vehicleColour ?? "No colour chosen"}</p>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-4">
                <Fact label="Stock no." value={unit?.stockNumber ?? "Not allocated"} />
                <Fact label="VIN / Serial" value={unit?.serial ? `••••${unit.serial.slice(-6)}` : "—"} />
                <Fact label="PDI" value={unit ? unit.pdiStatus.replaceAll("_", " ") : "After allocation"} />
                <Fact label="Source" value={lead?.source ?? "—"} />
              </div>
              {quote.status === "accepted" && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <Link href="/deliveries" className="btn-secondary btn-sm"><Truck className="size-4" />Delivery board</Link>
                  {quote.invoiceNumber && <Link href="/invoices?show=all" className="btn-secondary btn-sm">Invoices</Link>}
                </div>
              )}
            </Surface>

            <Surface className="p-5">
              <div className="flex items-center gap-2">
                <FileText className="size-5 text-muted-foreground" />
                <h2 className="text-sm font-semibold">{labels.deal.one} file</h2>
                <StatusPill tone={checklistDone === checklist.length ? "success" : "warning"}>{checklistDone} of {checklist.length}</StatusPill>
              </div>
              <div className="mt-3 divide-y divide-border/60">
                {checklist.map((item) => {
                  const ask = askable(item);
                  const waiting = ask
                    ? requests.find((r) => r.vendorId === ask.vendor.id && r.documentType === ask.documentType && documentRequestState(r, requestNow) === "open")
                    : undefined;
                  return (
                    <ReadinessRow
                      key={item.key}
                      done={item.done}
                      label={item.label}
                      detail={waiting ? `Asked ${formatDate(waiting.createdAt)} (${waiting.sentTo}) — waiting, until ${formatDate(waiting.expiresAt)}` : item.detail}
                      action={
                        waiting ? (
                          <SaveForm action={recallDocumentRequest.bind(null, waiting.quoteId, waiting.id)} success="Request withdrawn">
                            <SaveButton className="text-[11px] font-medium text-muted-foreground hover:text-foreground hover:underline" pendingLabel="Withdrawing…">Withdraw the request</SaveButton>
                          </SaveForm>
                        ) : ask ? (
                          <DocumentRequestButton quoteId={uploadQuoteId ?? quote.id} vendor={ask.vendor} documentType={ask.documentType} />
                        ) : undefined
                      }
                    />
                  );
                })}
              </div>
              <a href="#deal-file" className="btn-secondary btn-sm mt-4 w-full"><FileText className="size-4" />Open the file</a>
            </Surface>

          </aside>
        </div>
      </div>
      {/* "Chase the customer" / "Log a call or message" open the deal here, beside the page (?open=lead:<id>). */}
      <Suspense fallback={null}>
        <RecordDrawer />
      </Suspense>
    </EntityDetailShell>
  );
}
