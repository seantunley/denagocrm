import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Activity,
  BadgeCheck,
  Boxes,
  CalendarClock,
  CircleDollarSign,
  FileSignature,
  FileText,
  MessageSquareText,
  PackageCheck,
  ReceiptText,
  Truck,
  UserRound,
} from "lucide-react";
import { prisma } from "@/lib/db";
import { requireQuoteReadAccess } from "@/lib/permissions";
import { contactName, formatDate, formatDateTime, formatZAR } from "@/lib/format";
import { payableTotalCents } from "@/lib/pricing";
import { EntityDetailShell } from "@/components/entity-detail-shell";
import { EmptyState, SectionHeading, StatusPill, Surface } from "@/components/visual-system";

function statusTone(status: string): "neutral" | "success" | "warning" | "danger" | "info" {
  if (status === "accepted" || status === "completed" || status === "delivered") return "success";
  if (status === "declined" || status === "cancelled" || status === "rejected") return "danger";
  if (status === "sent" || status === "viewed" || status === "in_progress") return "info";
  if (status === "draft" || status === "pending") return "warning";
  return "neutral";
}

function Row({ label, value, href }: { label: string; value: React.ReactNode; href?: string }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-4 border-b border-border/60 py-2.5 last:border-0">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-sm font-medium text-foreground">
        {href ? <Link href={href} className="text-primary hover:underline">{value}</Link> : value}
      </dd>
    </div>
  );
}

function Stage({
  label,
  done,
  detail,
}: {
  label: string;
  done: boolean;
  detail?: string;
}) {
  return (
    <div className="flex gap-3">
      <span className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border ${done ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" : "border-border bg-muted/40 text-muted-foreground"}`}>
        {done ? <BadgeCheck className="size-4" /> : <span className="size-1.5 rounded-full bg-current" />}
      </span>
      <div className="min-w-0 pb-4">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {detail && <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>}
      </div>
    </div>
  );
}

export default async function DealWorkspacePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireQuoteReadAccess(id);

  const quote = await prisma.quote.findUnique({
    where: { id },
    include: {
      items: { include: { product: true }, orderBy: { sortOrder: "asc" } },
      fees: { orderBy: { sortOrder: "asc" } },
      contact: true,
      lead: {
        include: {
          assignedTo: true,
          activities: { orderBy: { dueDate: "asc" }, take: 20 },
          communications: {
            include: { user: true },
            orderBy: { occurredAt: "desc" },
            take: 12,
          },
        },
      },
      createdBy: true,
      soldStock: { include: { product: true } },
      stockReservations: {
        where: { status: "active" },
        include: {
          stockUnit: { include: { product: true } },
          reservedBy: true,
        },
        orderBy: { reservedAt: "desc" },
      },
    },
  });
  if (!quote || quote.deletedAt) notFound();

  const [documents, signatures] = await Promise.all([
    prisma.document.findMany({
      where: { quoteId: quote.id, deletedAt: null },
      select: {
        id: true,
        fileName: true,
        tag: true,
        sizeBytes: true,
        createdAt: true,
        uploadedBy: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    prisma.signatureRequest.findMany({
      where: { quoteId: quote.id, deletedAt: null },
      select: {
        id: true,
        title: true,
        status: true,
        sentAt: true,
        completedAt: true,
        createdAt: true,
      },
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
  const customer = quote.contact ? contactName(quote.contact) : quote.lead?.name || "Unlinked customer";
  const stock = [
    ...quote.soldStock.map((unit) => ({ ...unit, allocation: "Sold" })),
    ...quote.stockReservations
      .filter((reservation) => !quote.soldStock.some((unit) => unit.id === reservation.stockUnit.id))
      .map((reservation) => ({ ...reservation.stockUnit, allocation: "Reserved" })),
  ];
  const nextActivity = quote.lead?.activities.find((item) => item.status === "planned") ?? null;

  return (
    <EntityDetailShell
      backHref="/quotes"
      backLabel="Quotes"
      eyebrow="Deal workspace"
      title={`Q-${quote.number} · ${customer}`}
      status={<StatusPill tone={statusTone(quote.status)}>{quote.status}</StatusPill>}
      description={quote.lead ? quote.lead.title : "Commercial deal"}
      meta={`Created ${formatDate(quote.createdAt)}${quote.createdBy ? ` · by ${quote.createdBy.name}` : ""}`}
      facts={[
        { label: "Deal value", value: formatZAR(total) },
        { label: "Customer", value: customer },
        { label: "Stock", value: stock.length ? `${stock.length} unit${stock.length === 1 ? "" : "s"}` : "Not allocated" },
        { label: "Next action", value: nextActivity ? formatDateTime(nextActivity.dueDate) : "None planned" },
      ]}
      actions={
        <>
          <Link href={`/quotes?edit=${quote.id}`} className="btn-primary">Open quote editor</Link>
          {quote.leadId && <Link href={`/leads/${quote.leadId}`} className="btn-secondary">Open lead</Link>}
          <a href={`/quotes/${quote.id}/print`} target="_blank" rel="noreferrer" className="btn-secondary">Print / PDF</a>
        </>
      }
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,.65fr)]">
        <div className="space-y-4">
          <Surface className="p-4">
            <SectionHeading title="Deal progress" description="One operational path from proposal to handover." />
            <div className="mt-4 grid gap-x-6 sm:grid-cols-2">
              <Stage label="Quote prepared" done detail={`Q-${quote.number} · ${formatZAR(total)}`} />
              <Stage label="Sent to customer" done={quote.status !== "draft"} detail={quote.viewedAt ? `Viewed ${formatDateTime(quote.viewedAt)}` : undefined} />
              <Stage label="Accepted / signed" done={quote.status === "accepted" || Boolean(quote.signedAt)} detail={quote.signedAt ? formatDateTime(quote.signedAt) : undefined} />
              <Stage label="Invoiced" done={Boolean(quote.invoicedAt)} detail={quote.invoicedAt ? formatDateTime(quote.invoicedAt) : undefined} />
              <Stage label="Deposit received" done={Boolean(quote.depositPaidAt)} detail={quote.depositPaidAt ? formatDateTime(quote.depositPaidAt) : depositAmount ? `Expected ${formatZAR(depositAmount)}` : undefined} />
              <Stage label="Stock allocated" done={stock.length > 0} detail={stock.length ? stock.map((unit) => unit.stockNumber ?? unit.serial ?? unit.product.name).join(", ") : undefined} />
              <Stage label="Delivery scheduled" done={Boolean(quote.deliveryScheduledFor)} detail={quote.deliveryScheduledFor ? formatDateTime(quote.deliveryScheduledFor) : undefined} />
              <Stage label="Delivered" done={Boolean(quote.deliveredAt)} detail={quote.deliveredAt ? formatDateTime(quote.deliveredAt) : undefined} />
            </div>
          </Surface>

          <div className="grid gap-4 lg:grid-cols-2">
            <Surface className="p-4">
              <SectionHeading title="Customer & opportunity" description="The people and sales context behind this deal." action={<UserRound className="size-4 text-muted-foreground" />} />
              <dl className="mt-3">
                <Row label="Customer" value={customer} href={quote.contactId ? `/contacts/${quote.contactId}` : undefined} />
                <Row label="Email" value={quote.contact?.email ?? quote.lead?.email ?? "—"} />
                <Row label="Phone" value={quote.contact?.phone ?? quote.lead?.phone ?? "—"} />
                <Row label="Lead" value={quote.lead?.title ?? "—"} href={quote.leadId ? `/leads/${quote.leadId}` : undefined} />
                <Row label="Sales owner" value={quote.lead?.assignedTo?.name ?? quote.createdBy?.name ?? "Unassigned"} />
                <Row label="Source" value={quote.lead?.source ?? "—"} />
              </dl>
            </Surface>

            <Surface className="p-4">
              <SectionHeading title="Commercials" description="Quote economics currently stored on the deal." action={<CircleDollarSign className="size-4 text-muted-foreground" />} />
              <dl className="mt-3">
                <Row label="Total" value={formatZAR(total)} />
                <Row label="Deposit terms" value={quote.depositType ? (quote.depositType === "percent" ? `${quote.depositValue ?? 0}% · ${formatZAR(depositAmount)}` : formatZAR(depositAmount)) : "Not set"} />
                <Row label="Deposit status" value={quote.depositPaidAt ? `Received ${formatDate(quote.depositPaidAt)}` : "Not marked received"} />
                <Row label="Invoice status" value={quote.invoicedAt ? `Invoiced ${formatDate(quote.invoicedAt)}` : "Not invoiced"} />
                <Row label="Payment ledger" value="Not yet implemented" />
              </dl>
              <p className="mt-3 rounded-lg border border-border bg-muted/25 p-2.5 text-xs leading-5 text-muted-foreground">
                This workspace does not invent payment data. Actual receipts, balances, refunds and credit notes belong to the Deal Financials module.
              </p>
            </Surface>
          </div>

          <Surface className="p-4">
            <SectionHeading title="Vehicle & stock" description="Reserved or sold physical units tied to this quote." action={<Boxes className="size-4 text-muted-foreground" />} />
            {stock.length === 0 ? (
              <EmptyState icon={PackageCheck} title="No stock allocated" description="Reserve or allocate a stock unit from Stock when this deal is ready for fulfilment." className="mt-4" />
            ) : (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {stock.map((unit) => (
                  <Link key={unit.id} href={`/stock/${unit.id}`} className="rounded-lg border border-border bg-muted/20 p-3 transition-colors hover:bg-muted/40">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold">{unit.product.name}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{[unit.color, unit.stockNumber, unit.serial].filter(Boolean).join(" · ") || "Unit details pending"}</p>
                      </div>
                      <StatusPill tone={unit.status === "sold" ? "success" : "info"}>{unit.allocation}</StatusPill>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                      <span>PDI: <strong className="text-foreground">{unit.pdiStatus.replaceAll("_", " ")}</strong></span>
                      <span>Location: <strong className="text-foreground">{unit.location ?? "—"}</strong></span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </Surface>

          <div className="grid gap-4 lg:grid-cols-2">
            <Surface className="p-4">
              <SectionHeading title="Documents" description="Files already filed against this quote." action={<FileText className="size-4 text-muted-foreground" />} />
              {documents.length === 0 ? (
                <p className="mt-4 text-sm text-muted-foreground">No filed documents yet.</p>
              ) : (
                <div className="mt-3 space-y-1">
                  {documents.map((doc) => (
                    <Link key={doc.id} href={`/documents?q=${encodeURIComponent(doc.fileName)}`} className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-muted/40">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{doc.fileName}</p>
                        <p className="text-xs text-muted-foreground">{doc.tag ?? "file"} · {Math.max(1, Math.round(doc.sizeBytes / 1024))} KB · {doc.uploadedBy.name}</p>
                      </div>
                      <span className="text-xs text-muted-foreground">{formatDate(doc.createdAt)}</span>
                    </Link>
                  ))}
                </div>
              )}
            </Surface>

            <Surface className="p-4">
              <SectionHeading title="Signatures" description="Signing envelopes tied to this quote." action={<FileSignature className="size-4 text-muted-foreground" />} />
              {signatures.length === 0 ? (
                <p className="mt-4 text-sm text-muted-foreground">No signature requests yet.</p>
              ) : (
                <div className="mt-3 space-y-2">
                  {signatures.map((request) => (
                    <Link key={request.id} href={`/signatures/${request.id}`} className="flex items-center justify-between gap-3 rounded-lg border border-border/70 p-2.5 hover:bg-muted/40">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{request.title}</p>
                        <p className="text-xs text-muted-foreground">{request.completedAt ? `Completed ${formatDateTime(request.completedAt)}` : request.sentAt ? `Sent ${formatDateTime(request.sentAt)}` : `Created ${formatDateTime(request.createdAt)}`}</p>
                      </div>
                      <StatusPill tone={statusTone(request.status)}>{request.status.replaceAll("_", " ")}</StatusPill>
                    </Link>
                  ))}
                </div>
              )}
            </Surface>
          </div>
        </div>

        <div className="space-y-4">
          <Surface className="p-4">
            <SectionHeading title="Next actions" description="Sales activity without leaving the deal." action={<CalendarClock className="size-4 text-muted-foreground" />} />
            {!quote.lead ? (
              <p className="mt-4 text-sm text-muted-foreground">This quote is not linked to a lead.</p>
            ) : quote.lead.activities.filter((item) => item.status === "planned").length === 0 ? (
              <EmptyState icon={Activity} title="Nothing scheduled" description="Open the lead to schedule the next call, meeting or follow-up." className="mt-4" action={<Link href={`/leads/${quote.lead.id}?tab=activities&schedule=1`} className="btn-secondary btn-sm">Schedule activity</Link>} />
            ) : (
              <div className="mt-3 space-y-2">
                {quote.lead.activities.filter((item) => item.status === "planned").slice(0, 6).map((item) => (
                  <div key={item.id} className="rounded-lg border border-border/70 p-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm font-medium">{item.summary}</p>
                      <StatusPill tone={item.dueDate < new Date() ? "danger" : "neutral"}>{formatDate(item.dueDate)}</StatusPill>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{item.type}{item.location ? ` · ${item.location}` : ""}</p>
                  </div>
                ))}
              </div>
            )}
          </Surface>

          <Surface className="p-4">
            <SectionHeading title="Delivery" description="Fulfilment status for the accepted deal." action={<Truck className="size-4 text-muted-foreground" />} />
            <dl className="mt-3">
              <Row label="Scheduled" value={formatDateTime(quote.deliveryScheduledFor)} />
              <Row label="Delivered" value={formatDateTime(quote.deliveredAt)} />
              <Row label="Handed over by" value={quote.deliveredByName ?? "—"} />
              <Row label="Customer handover signature" value={quote.deliverySignatureRef ? "Captured" : "Not captured"} />
              <Row label="Dealer countersignature" value={quote.dealerSignedAt ? `Signed ${formatDate(quote.dealerSignedAt)}` : "Not signed"} />
            </dl>
            {quote.status === "accepted" && <Link href="/deliveries" className="btn-secondary btn-sm mt-3 w-full">Open delivery board</Link>}
          </Surface>

          <Surface className="p-4">
            <SectionHeading title="Recent communication" description="Latest messages recorded against the linked lead." action={<MessageSquareText className="size-4 text-muted-foreground" />} />
            {!quote.lead || quote.lead.communications.length === 0 ? (
              <p className="mt-4 text-sm text-muted-foreground">No communication recorded against this lead.</p>
            ) : (
              <div className="mt-3 space-y-3">
                {quote.lead.communications.slice(0, 8).map((message) => (
                  <div key={message.id} className="border-b border-border/60 pb-3 last:border-0 last:pb-0">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs font-medium capitalize">{message.type}{message.direction ? ` · ${message.direction}` : ""}</p>
                      <span className="text-[11px] text-muted-foreground">{formatDateTime(message.occurredAt)}</span>
                    </div>
                    {message.subject && <p className="mt-1 text-xs font-medium">{message.subject}</p>}
                    <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{message.body}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground/70">{message.user.name}</p>
                  </div>
                ))}
              </div>
            )}
            {quote.leadId && <Link href={`/leads/${quote.leadId}?tab=comms`} className="btn-secondary btn-sm mt-3 w-full">Open full timeline</Link>}
          </Surface>

          <Surface className="p-4">
            <SectionHeading title="Deal documents" description="Fast access to customer-facing output." action={<ReceiptText className="size-4 text-muted-foreground" />} />
            <div className="mt-3 grid gap-2">
              <a href={`/quotes/${quote.id}/print`} target="_blank" rel="noreferrer" className="btn-secondary btn-sm justify-start"><FileText className="size-4" />Quotation</a>
              {quote.status === "accepted" && <>
                <a href={`/quotes/${quote.id}/invoice`} target="_blank" rel="noreferrer" className="btn-secondary btn-sm justify-start"><ReceiptText className="size-4" />Invoice</a>
                <a href={`/quotes/${quote.id}/agreement`} target="_blank" rel="noreferrer" className="btn-secondary btn-sm justify-start"><FileSignature className="size-4" />Sales agreement</a>
                <a href={`/quotes/${quote.id}/delivery-note`} target="_blank" rel="noreferrer" className="btn-secondary btn-sm justify-start"><Truck className="size-4" />Delivery note</a>
              </>}
            </div>
          </Surface>
        </div>
      </div>
    </EntityDetailShell>
  );
}
