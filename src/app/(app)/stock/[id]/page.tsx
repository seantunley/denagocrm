import Link from "next/link";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { notFound } from "next/navigation";
import { Prisma } from "@prisma/client";
import {
  ArrowLeft,
  BadgeDollarSign,
  CalendarCheck,
  ClipboardCheck,
  Clock3,
  FileCheck2,
  History,
  MapPin,
  ShieldCheck,
  Tag,
  Trash2,
  UserRoundCheck,
  Wrench,
} from "lucide-react";
import { prisma } from "@/lib/db";
import { formatDateTime, formatZAR } from "@/lib/format";
import {
  allocateUnit,
  completePdi,
  deleteStockUnit,
  deliverStockUnit,
  inspectReceivedUnit,
  recordReservationDeposit,
  releaseUnit,
  reserveUnit,
  setStockUnitLabel,
  transitionStockUnit,
  updateStockUnit,
} from "@/app/actions/stock";
import { getStockLabels } from "@/lib/stockLabels";
import ModalTrigger from "@/components/Modal";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { FeedbackBanner, MetricCard, SectionHeading, StatusPill, Surface } from "@/components/visual-system";
import {
  getAccessibleLeadIds,
  getAccessibleQuoteIds,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";
import { stockEvents } from "@/lib/stockPlatform";

type Unit = {
  id: string; productId: string; productName: string; color: string | null; serial: string | null;
  stockNumber: string | null; status: string; costCents: number; landedCostCents: number;
  salePriceCents: number | null; notes: string | null; location: string | null; label: string | null; condition: string;
  batterySerial: string | null; chargerSerial: string | null; odometerKm: number | null;
  pdiStatus: string; pdiCompletedAt: Date | null; arrivedAt: Date | null; soldAt: Date | null;
  deliveredAt: Date | null; warrantyStartAt: Date | null; warrantyEndAt: Date | null;
  purchaseOrderId: string | null; purchaseOrderReference: string | null; supplier: string | null;
  reservedForLeadId: string | null; reservedLeadName: string | null; soldQuoteId: string | null;
  quoteNumber: number | null; reservationExpiresAt: Date | null; depositRequiredCents: number | null;
  depositReceivedAt: Date | null; ageDays: number;
};

const statusMeta: Record<string, { label: string; tone: "neutral" | "success" | "warning" | "danger" | "info" }> = {
  incoming: { label: "Incoming", tone: "info" },
  received_pending_check: { label: "Awaiting inspection", tone: "warning" },
  available: { label: "Available", tone: "success" },
  reserved: { label: "Reserved", tone: "warning" },
  allocated: { label: "Allocated", tone: "info" },
  pdi: { label: "PDI in progress", tone: "warning" },
  ready_for_delivery: { label: "Ready for delivery", tone: "success" },
  delivered: { label: "Delivered", tone: "neutral" },
  sold: { label: "Delivered", tone: "neutral" },
  hold: { label: "On hold", tone: "danger" },
  damaged: { label: "Damaged", tone: "danger" },
};

export default async function StockUnitPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireAnyPermission("stock.view", "stock.manage");
  const canManage = await hasPermission(user, "stock.manage");
  const { id } = await params;
  const [unit] = await prisma.$queryRaw<Unit[]>(Prisma.sql`
    SELECT su."id", su."productId", p."name" AS "productName", su."color", su."serial",
      su."stockNumber", su."status", su."costCents", su."landedCostCents", su."salePriceCents",
      su."notes", su."location", su."label", su."condition", su."batterySerial", su."chargerSerial", su."odometerKm",
      su."pdiStatus", su."pdiCompletedAt", su."arrivedAt", su."soldAt", su."deliveredAt",
      su."warrantyStartAt", su."warrantyEndAt", su."purchaseOrderId", po."reference" AS "purchaseOrderReference",
      po."supplier", su."reservedForLeadId", l."name" AS "reservedLeadName", su."soldQuoteId",
      q."number" AS "quoteNumber", r."expiresAt" AS "reservationExpiresAt",
      r."depositRequiredCents", r."depositReceivedAt",
      GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - COALESCE(su."arrivedAt", su."createdAt"))) / 86400))::int AS "ageDays"
    FROM "StockUnit" su
    JOIN "Product" p ON p."id" = su."productId"
    LEFT JOIN "PurchaseOrder" po ON po."id" = su."purchaseOrderId"
    LEFT JOIN "Lead" l ON l."id" = su."reservedForLeadId"
    LEFT JOIN "Quote" q ON q."id" = su."soldQuoteId"
    LEFT JOIN "StockReservation" r ON r."stockUnitId" = su."id" AND r."status" = 'active'
    WHERE su."id" = ${id} AND su."deletedAt" IS NULL
  `);
  if (!unit) notFound();

  const [events, leadScope, quoteScope, stockLabels] = await Promise.all([
    stockEvents(unit.id),
    getAccessibleLeadIds(user),
    getAccessibleQuoteIds(user),
    getStockLabels(),
  ]);
  const labelMeta = stockLabels.find((l) => l.slug === unit.label) ?? null;
  const [leads, quotes] = canManage ? await Promise.all([
    prisma.lead.findMany({
      where: {
        status: "open",
        deletedAt: null,
        ...(leadScope === null ? {} : { id: { in: leadScope } }),
        OR: [{ productId: unit.productId }, { productId: null }],
      },
      select: { id: true, title: true, name: true, productId: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.quote.findMany({
      where: {
        status: "accepted",
        deletedAt: null,
        ...(quoteScope === null ? {} : { id: { in: quoteScope } }),
        items: { some: { productId: unit.productId, selected: true } },
      },
      select: { id: true, number: true, lead: { select: { name: true } }, contact: { select: { firstName: true, lastName: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]) : [[], []];

  const meta = statusMeta[unit.status] ?? { label: unit.status.replaceAll("_", " "), tone: "neutral" as const };
  const nextStep = {
    incoming: "Receive the supplier order before inspecting this unit.",
    received_pending_check: "Capture its serial and inspect the physical condition.",
    available: "Reserve it for an open lead or allocate it directly to an accepted quote.",
    reserved: "Record the deposit, allocate an accepted quote, or release the reservation.",
    allocated: "Move the allocated cart into pre-delivery inspection.",
    pdi: "Complete the PDI checklist and resolve any issues.",
    ready_for_delivery: "Complete the customer handover and activate the warranty.",
    delivered: "This cart is now a customer vehicle with a permanent stock history.",
    sold: "This cart is now a customer vehicle with a permanent stock history.",
    hold: "Resolve the hold reason before returning the cart to its workflow.",
    damaged: "Record the repair or disposal decision before making it available.",
  }[unit.status] ?? "Review the unit and choose the appropriate next step.";

  return (
    <div className="space-y-6">
      <Link href="/stock" className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="size-4" /> Back to stock operations
      </Link>

      <PageHeader
        title={unit.stockNumber ?? unit.productName}
        description={`${unit.productName}${unit.color ? ` · ${unit.color}` : ""}${unit.serial ? ` · ${unit.serial}` : " · serial pending"}`}
      >
        <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
        {labelMeta && (
          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: `${labelMeta.color}22`, color: labelMeta.color }}>
            <Tag className="size-3" /> {labelMeta.label}
          </span>
        )}
        {canManage && (
          <ModalTrigger label="Label" title="Organisational label" buttonClass={buttonVariants({ variant: "outline", size: "sm" })}>
            <SaveForm success="Label updated" resetOnSuccess={false} action={setStockUnitLabel.bind(null, unit.id)} className="space-y-3">
              <p className="text-xs text-muted-foreground">
                A label is separate from the lifecycle status — flag demo units, showroom stock, consignment, holds, etc. Manage the list in Settings → Stock.
              </p>
              <select name="label" className="input" defaultValue={unit.label ?? ""}>
                <option value="">No label</option>
                {stockLabels.map((l) => <option key={l.slug} value={l.slug}>{l.label}</option>)}
              </select>
              <SaveButton className={buttonVariants({ size: "sm" })}>Save label</SaveButton>
            </SaveForm>
          </ModalTrigger>
        )}
        {canManage && (
          <ModalTrigger label="Edit details" title="Edit stock unit" buttonClass={buttonVariants({ variant: "outline", size: "sm" })}>
            <SaveForm success="Stock unit saved" resetOnSuccess={false} action={updateStockUnit.bind(null, unit.id)} className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div><label className="label">Serial / VIN</label><input name="serial" className="input font-mono uppercase" defaultValue={unit.serial ?? ""} /></div>
                <div><label className="label">Colour</label><input name="color" className="input" defaultValue={unit.color ?? ""} /></div>
                <div><label className="label">Location</label><input name="location" className="input" defaultValue={unit.location ?? ""} placeholder="Showroom / yard / warehouse" /></div>
                <div><label className="label">Condition</label><select name="condition" className="input" defaultValue={unit.condition}><option value="new">New</option><option value="demo">Demo</option><option value="used">Used</option><option value="damaged">Damaged</option><option value="consignment">Consignment</option></select></div>
                <div><label className="label">Acquisition cost (R)</label><input name="cost" className="input" defaultValue={(unit.costCents / 100).toFixed(2)} /></div>
                <div><label className="label">Landed cost (R)</label><input name="landedCost" className="input" defaultValue={((unit.landedCostCents || unit.costCents) / 100).toFixed(2)} /></div>
                <div><label className="label">Battery serial</label><input name="batterySerial" className="input font-mono" defaultValue={unit.batterySerial ?? ""} /></div>
                <div><label className="label">Charger serial</label><input name="chargerSerial" className="input font-mono" defaultValue={unit.chargerSerial ?? ""} /></div>
                <div><label className="label">Odometer / km</label><input name="odometerKm" type="number" min="0" className="input" defaultValue={unit.odometerKm ?? ""} /></div>
                <div className="sm:col-span-2"><label className="label">Internal notes</label><textarea name="notes" className="input min-h-28" defaultValue={unit.notes ?? ""} /></div>
              </div>
              <SaveButton className="btn-primary">Save changes</SaveButton>
            </SaveForm>
          </ModalTrigger>
        )}
      </PageHeader>

      <FeedbackBanner tone={unit.status === "hold" || unit.status === "damaged" ? "danger" : "info"} title="Recommended next step">{nextStep}</FeedbackBanner>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard icon={Clock3} label="Stock age" value={`${unit.ageDays}d`} detail={unit.arrivedAt ? `Arrived ${unit.arrivedAt.toLocaleDateString("en-ZA")}` : "Arrival pending"} accent={unit.ageDays >= 60} />
        <MetricCard icon={BadgeDollarSign} label="Landed cost" value={formatZAR(unit.landedCostCents || unit.costCents)} detail={unit.salePriceCents ? `Sold ${formatZAR(unit.salePriceCents)}` : "Current inventory basis"} />
        <MetricCard icon={MapPin} label="Location" value={unit.location ?? "Unassigned"} detail={unit.condition} />
        <MetricCard icon={ClipboardCheck} label="PDI" value={unit.pdiStatus.replaceAll("_", " ")} detail={unit.pdiCompletedAt ? formatDateTime(unit.pdiCompletedAt) : "Not completed"} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.8fr)]">
        <div className="space-y-5">
          {canManage && (
            <Surface className="p-5">
              <SectionHeading title="Workflow actions" description="Only valid transitions for this unit's current state are available." />
              <div className="mt-4 flex flex-wrap gap-2">
                {unit.status === "received_pending_check" && (
                  <ModalTrigger label="Inspect arrival" title="Inspect received unit" buttonClass="btn-primary">
                    <SaveForm success="Inspection recorded" resetOnSuccess={false} action={inspectReceivedUnit.bind(null, unit.id)} className="space-y-4">
                      <div><label className="label">Serial / VIN *</label><input name="serial" className="input font-mono uppercase" defaultValue={unit.serial ?? ""} required /></div>
                      <div><label className="label">Storage location</label><input name="location" className="input" defaultValue={unit.location ?? ""} /></div>
                      <div><label className="label">Inspection result</label><select name="accepted" className="input" defaultValue="yes"><option value="yes">Accepted into available stock</option><option value="no">Damaged / quarantine</option></select></div>
                      <div><label className="label">Condition notes</label><textarea name="conditionNote" className="input min-h-24" /></div>
                      <SaveButton className="btn-primary">Complete inspection</SaveButton>
                    </SaveForm>
                  </ModalTrigger>
                )}

                {unit.status === "available" && leads.length > 0 && (
                  <ModalTrigger label="Reserve for lead" title="Reserve this unit" buttonClass="btn-primary">
                    <SaveForm success="Unit reserved" resetOnSuccess={false} action={reserveUnit.bind(null, unit.id)} className="space-y-4">
                      <div><label className="label">Open lead *</label><select name="leadId" className="input" required defaultValue=""><option value="" disabled>Choose lead…</option>{leads.map((lead) => <option key={lead.id} value={lead.id}>{lead.title} — {lead.name}</option>)}</select></div>
                      <div className="grid grid-cols-2 gap-3"><div><label className="label">Reservation days</label><input name="days" type="number" min="1" max="30" defaultValue="3" className="input" /></div><div><label className="label">Deposit required (R)</label><input name="depositRequired" className="input" placeholder="0.00" /></div></div>
                      <SaveButton className="btn-primary">Reserve unit</SaveButton>
                    </SaveForm>
                  </ModalTrigger>
                )}

                {["available", "reserved"].includes(unit.status) && quotes.length > 0 && (
                  <ModalTrigger label="Allocate accepted quote" title="Allocate unit" buttonClass="btn-primary">
                    <SaveForm success="Unit allocated" resetOnSuccess={false} action={allocateUnit.bind(null, unit.id)} className="space-y-4">
                      <div><label className="label">Accepted quote *</label><select name="quoteId" className="input" required defaultValue=""><option value="" disabled>Choose quote…</option>{quotes.map((quote) => <option key={quote.id} value={quote.id}>Q-{quote.number} — {quote.contact ? `${quote.contact.firstName} ${quote.contact.lastName ?? ""}` : quote.lead?.name ?? "Customer"}</option>)}</select></div>
                      <SaveButton className="btn-primary">Allocate to quote</SaveButton>
                    </SaveForm>
                  </ModalTrigger>
                )}

                {unit.status === "reserved" && !unit.depositReceivedAt && (
                  <ModalTrigger label="Record deposit" title="Record reservation deposit" buttonClass="btn-secondary">
                    <SaveForm success="Deposit recorded" resetOnSuccess={false} action={recordReservationDeposit.bind(null, unit.id)} className="space-y-4"><div><label className="label">Payment reference</label><input name="reference" className="input" /></div><SaveButton className="btn-primary">Confirm deposit received</SaveButton></SaveForm>
                  </ModalTrigger>
                )}

                {["reserved", "allocated"].includes(unit.status) && (
                  <ModalTrigger label="Release" title="Release this unit" buttonClass="btn-secondary">
                    <SaveForm success="Reservation released" resetOnSuccess={false} action={releaseUnit.bind(null, unit.id)} className="space-y-4"><div><label className="label">Reason *</label><textarea name="reason" className="input min-h-24" required /></div><SaveButton className="btn-primary">Return to available stock</SaveButton></SaveForm>
                  </ModalTrigger>
                )}

                {unit.status === "allocated" && <SaveForm success="Status updated" resetOnSuccess={false} action={transitionStockUnit.bind(null, unit.id)}><input type="hidden" name="status" value="pdi" /><SaveButton className="btn-primary"><Wrench className="size-4" /> Start PDI</SaveButton></SaveForm>}

                {unit.status === "pdi" && (
                  <ModalTrigger label="Complete PDI" title="Complete pre-delivery inspection" buttonClass="btn-primary">
                    <SaveForm success="PDI completed" resetOnSuccess={false} action={completePdi.bind(null, unit.id)} className="space-y-4"><div><label className="label">Outcome</label><select name="passed" className="input" defaultValue="yes"><option value="yes">Passed — ready for delivery</option><option value="no">Failed — place on hold</option></select></div><div><label className="label">Issues / work completed</label><textarea name="issues" className="input min-h-28" /></div><SaveButton className="btn-primary">Complete PDI</SaveButton></SaveForm>
                  </ModalTrigger>
                )}

                {unit.status === "ready_for_delivery" && (
                  <ModalTrigger label="Complete delivery" title="Customer handover" buttonClass="btn bg-emerald-700 text-white hover:bg-emerald-600">
                    <SaveForm success="Unit delivered" resetOnSuccess={false} action={deliverStockUnit.bind(null, unit.id)} className="space-y-4"><p className="text-sm text-muted-foreground">This creates the customer&apos;s vehicle record, files the sale value and starts the warranty.</p><div><label className="label">Warranty months</label><input name="warrantyMonths" type="number" min="0" defaultValue="12" className="input" /></div><SaveButton className="btn bg-emerald-700 text-white hover:bg-emerald-600">Confirm delivered</SaveButton></SaveForm>
                  </ModalTrigger>
                )}

                {["available", "allocated", "pdi"].includes(unit.status) && (
                  <ModalTrigger label="Place on hold" title="Place unit on hold" buttonClass="btn-secondary">
                    <SaveForm success="Status updated" resetOnSuccess={false} action={transitionStockUnit.bind(null, unit.id)} className="space-y-4"><input type="hidden" name="status" value="hold" /><div><label className="label">Reason *</label><textarea name="reason" className="input min-h-24" required /></div><SaveButton className="btn-danger">Place on hold</SaveButton></SaveForm>
                  </ModalTrigger>
                )}

                {unit.status === "hold" && <SaveForm success="Status updated" resetOnSuccess={false} action={transitionStockUnit.bind(null, unit.id)}><input type="hidden" name="status" value={unit.soldQuoteId ? "allocated" : "available"} /><SaveButton className="btn-primary">Resolve hold</SaveButton></SaveForm>}
                {unit.status === "damaged" && <SaveForm success="Status updated" resetOnSuccess={false} action={transitionStockUnit.bind(null, unit.id)}><input type="hidden" name="status" value="hold" /><SaveButton className="btn-secondary">Send for assessment</SaveButton></SaveForm>}
              </div>
            </Surface>
          )}

          <Surface className="p-5">
            <SectionHeading title="Unit identity" description="Manufacturer identity, supplied equipment and purchasing provenance." />
            <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
              {[
                ["Stock number", unit.stockNumber], ["Serial / VIN", unit.serial], ["Battery serial", unit.batterySerial], ["Charger serial", unit.chargerSerial],
                ["Colour", unit.color], ["Condition", unit.condition], ["Odometer", unit.odometerKm != null ? `${unit.odometerKm} km` : null],
                ["Supplier", unit.supplier], ["Purchase order", unit.purchaseOrderReference], ["Location", unit.location],
              ].map(([label, value]) => <div key={String(label)} className="rounded-xl border border-border bg-background/30 p-3"><dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</dt><dd className="mt-1 font-medium text-foreground">{value || "Not recorded"}</dd></div>)}
            </dl>
            {unit.notes && <div className="mt-4 rounded-xl border border-border bg-muted/20 p-4"><p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Internal notes</p><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground">{unit.notes}</p></div>}
          </Surface>
        </div>

        <div className="space-y-5">
          {(unit.reservedForLeadId || unit.soldQuoteId) && (
            <Surface className="p-5">
              <SectionHeading title="Commercial allocation" description="The CRM opportunity and accepted commercial record attached to this cart." />
              <div className="mt-4 space-y-3">
                {unit.reservedForLeadId && <Link href={`/leads/${unit.reservedForLeadId}`} className="flex items-center gap-3 rounded-xl border border-border bg-background/30 p-3 hover:border-primary/30"><UserRoundCheck className="size-4 text-primary" /><div><p className="text-xs text-muted-foreground">Reserved lead</p><p className="font-medium">{unit.reservedLeadName}</p></div></Link>}
                {unit.soldQuoteId && <Link href={`/quotes/${unit.soldQuoteId}`} className="flex items-center gap-3 rounded-xl border border-border bg-background/30 p-3 hover:border-primary/30"><FileCheck2 className="size-4 text-primary" /><div><p className="text-xs text-muted-foreground">Accepted quote</p><p className="font-medium">Q-{unit.quoteNumber}</p></div></Link>}
                {unit.reservationExpiresAt && <div className="flex items-center gap-3 rounded-xl border border-border bg-background/30 p-3"><CalendarCheck className="size-4 text-amber-300" /><div><p className="text-xs text-muted-foreground">Reservation expires</p><p className="font-medium">{formatDateTime(unit.reservationExpiresAt)}</p></div></div>}
                {unit.depositRequiredCents != null && unit.depositRequiredCents > 0 && <div className="flex items-center gap-3 rounded-xl border border-border bg-background/30 p-3"><BadgeDollarSign className="size-4 text-emerald-300" /><div><p className="text-xs text-muted-foreground">Deposit</p><p className="font-medium">{unit.depositReceivedAt ? `Received ${formatDateTime(unit.depositReceivedAt)}` : `${formatZAR(unit.depositRequiredCents)} required`}</p></div></div>}
              </div>
            </Surface>
          )}

          <Surface className="p-5">
            <SectionHeading title="Lifecycle history" description="Append-only operational events for this physical unit." action={<History className="size-4 text-muted-foreground" />} />
            {events.length === 0 ? <p className="mt-4 text-sm text-muted-foreground">No lifecycle events have been recorded yet.</p> : (
              <ol className="relative mt-5 space-y-5 border-l border-border pl-5">
                {events.map((event) => (
                  <li key={event.id} className="relative">
                    <span className="absolute -left-[26px] top-1.5 size-2.5 rounded-full border-2 border-card bg-primary" />
                    <p className="text-sm font-medium capitalize">{event.eventType.replaceAll(".", " ").replaceAll("_", " ")}</p>
                    {(event.fromStatus || event.toStatus) && <p className="mt-0.5 text-xs text-muted-foreground">{event.fromStatus?.replaceAll("_", " ") ?? "Created"} → {event.toStatus?.replaceAll("_", " ") ?? "—"}</p>}
                    {event.reason && <p className="mt-1 text-xs leading-5 text-foreground">{event.reason}</p>}
                    {event.detail && <p className="mt-1 text-xs leading-5 text-muted-foreground">{event.detail}</p>}
                    <p className="mt-1 text-[11px] text-muted-foreground">{event.performedByName} · {formatDateTime(event.occurredAt)}</p>
                  </li>
                ))}
              </ol>
            )}
          </Surface>

          {unit.warrantyStartAt && (
            <Surface className="p-5">
              <SectionHeading title="Warranty" description="Activated automatically at delivery." action={<ShieldCheck className="size-4 text-emerald-300" />} />
              <p className="mt-4 text-sm">Started {unit.warrantyStartAt.toLocaleDateString("en-ZA")}</p>
              <p className="mt-1 text-sm text-muted-foreground">{unit.warrantyEndAt ? `Expires ${unit.warrantyEndAt.toLocaleDateString("en-ZA")}` : "No expiry recorded"}</p>
            </Surface>
          )}

          {canManage && !["reserved", "allocated", "pdi", "ready_for_delivery", "delivered", "sold"].includes(unit.status) && (
            <Surface className="border-red-400/20 p-5">
              <SectionHeading title="Archive unit" description="Remove this record from active inventory while retaining its audit history." action={<Trash2 className="size-4 text-red-300" />} />
              <ModalTrigger label="Remove from active stock" title="Archive stock unit" buttonClass="btn-danger btn-sm mt-4">
                <SaveForm success="Stock unit deleted" resetOnSuccess={false} action={deleteStockUnit.bind(null, unit.id)} className="space-y-4"><div><label className="label">Reason *</label><textarea name="reason" className="input min-h-24" required /></div><SaveButton className="btn-danger">Archive unit</SaveButton></SaveForm>
              </ModalTrigger>
            </Surface>
          )}
        </div>
      </div>
    </div>
  );
}
