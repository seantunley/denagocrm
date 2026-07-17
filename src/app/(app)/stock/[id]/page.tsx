import Link from "next/link";
import { notFound } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  BadgeDollarSign,
  BatteryCharging,
  Camera,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  FileText,
  Fingerprint,
  Gauge,
  History,
  KeyRound,
  MapPin,
  PackageCheck,
  PauseCircle,
  QrCode,
  ShieldCheck,
  Tag,
  Truck,
  UserRound,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { prisma } from "@/lib/db";
import { getQuoteStockAssignments, getStockLocations, getStockUnitDetail } from "@/lib/stockPlatform";
import {
  STOCK_STATUS_LABELS,
  STOCK_STATUS_TONES,
  allowedStockTransitions,
  isStockStatus,
  reservationUrgency,
  stockAgeBand,
  stockAgeDays,
} from "@/lib/stockWorkflow";
import { getStockStatuses } from "@/lib/stockStatuses";
import {
  getAccessibleLeadIds,
  getAccessibleQuoteIds,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";
import {
  allocateUnitToQuote,
  beginPdi,
  changeStockStatus,
  completePdi,
  deleteStockUnit,
  recordReservationDeposit,
  releaseUnit,
  reserveUnit,
  updateStockUnit,
  uploadStockFiles,
} from "@/app/actions/stock";
import { setStockStatus } from "@/app/actions/stockStatuses";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { FeedbackBanner, MetricCard, SectionHeading, StatusPill, Surface } from "@/components/visual-system";
import ModalTrigger from "@/components/Modal";
import { formatDateTime, formatZAR } from "@/lib/format";

const COMMITTED = new Set(["reserved", "allocated", "pdi", "ready", "sold", "delivered"]);
const PDI_CHECKS = [
  ["battery", "Battery & terminals"], ["charger", "Charger & cable"],
  ["tyres", "Tyres & pressure"], ["brakes", "Brakes"],
  ["lights", "Lights & indicators"], ["body", "Body & trim"],
  ["keys", "Keys / remotes"], ["roadTest", "Road test"],
] as const;

type Fact = { label: string; value: string | number; icon: LucideIcon };

function quoteCustomer(quote: {
  contact: { company: string | null; firstName: string; lastName: string | null } | null;
  lead: { name: string } | null;
}) {
  const person = [quote.contact?.firstName, quote.contact?.lastName].filter(Boolean).join(" ");
  const contact = quote.contact?.company ?? person;
  return contact || quote.lead?.name || "Customer";
}

export default async function StockUnitPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireAnyPermission("stock.view", "stock.manage");
  const canManage = await hasPermission(user, "stock.manage");
  const { id } = await params;
  const [unit, locations, statuses, leadScope, quoteScope] = await Promise.all([
    getStockUnitDetail(id), getStockLocations(), getStockStatuses(),
    getAccessibleLeadIds(user), getAccessibleQuoteIds(user),
  ]);
  if (!unit) notFound();

  const [leads, quotes] = await Promise.all([
    prisma.lead.findMany({
      where: {
        status: "open", deletedAt: null,
        OR: [{ productId: unit.productId }, { productId: null }],
        ...(leadScope === null ? {} : { id: { in: leadScope } }),
      },
      include: { stage: true }, orderBy: { createdAt: "desc" }, take: 250,
    }),
    prisma.quote.findMany({
      where: {
        status: "accepted", deliveredAt: null, supersededAt: null, deletedAt: null,
        ...(quoteScope === null ? {} : { id: { in: quoteScope } }),
        OR: [{ lead: { productId: unit.productId } }, { items: { some: { productId: unit.productId, selected: true } } }],
      },
      include: { contact: true, lead: true }, orderBy: { updatedAt: "desc" }, take: 100,
    }),
  ]);
  const assignments = await getQuoteStockAssignments(quotes.map((quote) => quote.id));
  const occupied = new Set(assignments.filter((item) => item.stockUnitId !== id).map((item) => item.quoteId));
  const selectableQuotes = quotes.filter((quote) => !occupied.has(quote.id));
  const systemStatus = isStockStatus(unit.status) ? unit.status : null;
  const statusOption = statuses.find((status) => status.slug === unit.status);
  const customStatuses = statuses.filter((status) => !status.system);
  const age = stockAgeDays(unit.arrivedAt ?? unit.createdAt);
  const ageBand = stockAgeBand(age);
  const landedCost = unit.landedCostCents || unit.costCents;
  const margin = unit.salePriceCents > 0 ? unit.salePriceCents - landedCost : null;
  const reservationState = reservationUrgency(unit.reservation?.expiresAt ?? null);
  const allowed = systemStatus
    ? allowedStockTransitions(systemStatus).filter((target) => ["available", "hold", "damaged"].includes(target))
    : [];
  const facts: Fact[] = [
    { label: "Model", value: unit.productName, icon: Gauge },
    { label: "Serial", value: unit.serial ?? "Pending", icon: Fingerprint },
    { label: "Battery", value: unit.batteryType ?? "Not recorded", icon: BatteryCharging },
    { label: "Battery serial", value: unit.batterySerial ?? "Not recorded", icon: ShieldCheck },
    { label: "Charger", value: unit.chargerSerial ?? "Not recorded", icon: BatteryCharging },
    { label: "Keys", value: unit.keyCount ?? "Not recorded", icon: KeyRound },
    { label: "Location", value: unit.locationName ?? "Unassigned", icon: MapPin },
    { label: "Arrived", value: unit.arrivedAt ? formatDateTime(unit.arrivedAt) : "Not recorded", icon: Truck },
  ];

  return (
    <div className="denago-workspace space-y-6">
      <Link href="/stock" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Back to stock</Link>
      <PageHeader title={unit.stockNumber ?? unit.productName} description={`${unit.productName}${unit.color ? ` · ${unit.color}` : ""}${unit.serial ? ` · ${unit.serial}` : " · serial pending"}`}>
        {systemStatus ? <StatusPill tone={STOCK_STATUS_TONES[systemStatus]}>{STOCK_STATUS_LABELS[systemStatus]}</StatusPill> : (
          <span className="rounded-full border px-2.5 py-1 text-xs font-semibold" style={{ borderColor: `${statusOption?.color ?? "#64748b"}55`, backgroundColor: `${statusOption?.color ?? "#64748b"}18`, color: statusOption?.color ?? "#94a3b8" }}>{statusOption?.label ?? unit.status.replaceAll("-", " ")}</span>
        )}
        <Link href={`/stock/${id}/label`} target="_blank" className={buttonVariants({ variant: "outline", size: "sm" })}><QrCode className="size-4" /> Print label</Link>
        {unit.soldQuoteId && <Link href={`/quotes/${unit.soldQuoteId}`} className={buttonVariants({ size: "sm" })}><FileText className="size-4" /> Q-{unit.soldQuoteNumber ?? "—"}</Link>}
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-6">
        <MetricCard icon={Fingerprint} label="Serial / VIN" value={unit.serial ?? "Pending"} detail={unit.stockNumber ?? "Internal ID pending"} accent />
        <MetricCard icon={MapPin} label="Location" value={unit.locationName ?? "Unassigned"} detail={unit.condition} />
        <MetricCard icon={Clock3} label="Age in stock" value={age == null ? "—" : `${age} days`} detail={ageBand === "critical" ? "Immediate attention" : ageBand === "aged" ? "Prioritise in sales" : "Within target"} />
        <MetricCard icon={BadgeDollarSign} label="Landed cost" value={canManage ? formatZAR(landedCost) : "Restricted"} detail="Valuation basis" />
        <MetricCard icon={Tag} label="Sale value" value={canManage && unit.salePriceCents ? formatZAR(unit.salePriceCents) : "—"} detail={margin == null ? "No allocated quote" : `Margin ${formatZAR(margin)}`} />
        <MetricCard icon={ClipboardCheck} label="PDI" value={unit.pdiStatus.replaceAll("_", " ")} detail={unit.pdiCompletedAt ? formatDateTime(unit.pdiCompletedAt) : "Not completed"} />
      </div>

      {unit.status === "damaged" && <FeedbackBanner tone="danger" title="This unit is marked damaged">{unit.holdReason ?? "No damage reason recorded."}</FeedbackBanner>}
      {unit.status === "hold" && <FeedbackBanner tone="warning" title="This unit is on operational hold">{unit.holdReason ?? "No hold reason recorded."}</FeedbackBanner>}
      {unit.reservation && ["expired", "today", "soon"].includes(reservationState) && <FeedbackBanner tone={reservationState === "soon" ? "warning" : "danger"} title="Reservation needs attention">Reserved for {unit.reservation.leadName}{unit.reservation.expiresAt ? ` until ${formatDateTime(unit.reservation.expiresAt)}` : " without an expiry"}.</FeedbackBanner>}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-5">
          <Surface className="p-5">
            <SectionHeading title="Operational workflow" description="Validated transitions are written to the permanent movement ledger." action={<PackageCheck className="size-5 text-primary" />} />
            <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
              {["available", "reserved", "allocated", "pdi", "ready", "sold", "delivered"].map((step, index, stages) => {
                const currentIndex = stages.indexOf(unit.status);
                const active = step === unit.status;
                const complete = currentIndex >= 0 && index < currentIndex;
                return <div key={step} className={`rounded-xl border px-3 py-3 text-center ${active ? "border-primary/40 bg-primary/10" : complete ? "border-emerald-400/20 bg-emerald-400/10" : "border-border bg-background/30"}`}><span className={`mx-auto grid size-7 place-items-center rounded-full ${active ? "bg-primary text-primary-foreground" : complete ? "bg-emerald-400/15 text-emerald-300" : "bg-muted text-muted-foreground"}`}>{complete ? <CheckCircle2 className="size-4" /> : index + 1}</span><p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.08em]">{step === "pdi" ? "PDI" : step}</p></div>;
              })}
            </div>

            {canManage && <div className="mt-5 space-y-4 border-t border-border pt-5">
              {unit.status === "available" && <form action={reserveUnit.bind(null, id)} className="rounded-2xl border border-border bg-background/30 p-4"><div className="flex items-center gap-2"><UserRound className="size-4 text-primary" /><p className="font-semibold">Reserve for an open lead</p></div><div className="mt-4 grid gap-3 md:grid-cols-4"><select name="leadId" className="input md:col-span-2" required defaultValue=""><option value="" disabled>Select lead…</option>{leads.map((lead) => <option key={lead.id} value={lead.id}>{lead.title} — {lead.name} · {lead.stage.name}</option>)}</select><input name="expiryDays" type="number" min="1" max="30" defaultValue="3" className="input" /><input name="depositRequired" inputMode="decimal" className="input" placeholder="Deposit required (R)" /></div><button className="btn-primary btn-sm mt-3">Reserve unit</button></form>}

              {unit.status === "reserved" && unit.reservation && <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 p-4"><p className="font-semibold text-amber-100">Reserved for {unit.reservation.leadName}</p><p className="mt-1 text-xs text-amber-100/70">Since {formatDateTime(unit.reservation.reservedAt)}{unit.reservation.expiresAt ? ` · expires ${formatDateTime(unit.reservation.expiresAt)}` : ""}</p><div className="mt-4 flex flex-wrap gap-2"><Link href={`/leads/${unit.reservation.leadId}`} className="btn-secondary btn-sm">Open lead</Link>{unit.reservation.depositRequiredCents > 0 && !unit.reservation.depositReceivedAt && <form action={recordReservationDeposit.bind(null, id)}><button className="btn-primary btn-sm">Record {formatZAR(unit.reservation.depositRequiredCents)} deposit</button></form>}<ModalTrigger label="Release reservation" title="Release reservation" buttonClass="btn-secondary btn-sm"><form action={releaseUnit.bind(null, id)} className="card space-y-3"><textarea name="reason" className="input min-h-24" required placeholder="Release reason" /><button className="btn-danger w-full">Release reservation</button></form></ModalTrigger></div></div>}

              {["available", "reserved"].includes(unit.status) && selectableQuotes.length > 0 && <form action={allocateUnitToQuote.bind(null, id)} className="rounded-2xl border border-sky-400/20 bg-sky-400/10 p-4"><div className="flex items-center gap-2"><FileText className="size-4 text-sky-300" /><p className="font-semibold text-sky-100">Allocate to an accepted quote</p></div><div className="mt-4 flex flex-col gap-3 sm:flex-row"><select name="quoteId" className="input flex-1" required defaultValue=""><option value="" disabled>Select accepted quote…</option>{selectableQuotes.map((quote) => <option key={quote.id} value={quote.id}>Q-{quote.number} — {quoteCustomer(quote)}</option>)}</select><button className="btn-primary">Allocate unit</button></div></form>}

              {unit.status === "allocated" && <form action={beginPdi.bind(null, id)} className="rounded-2xl border border-primary/20 bg-primary/10 p-4"><div className="flex items-center justify-between gap-3"><div><p className="font-semibold">Start pre-delivery inspection</p><p className="mt-1 text-xs text-muted-foreground">Moves the unit into preparation.</p></div><button className="btn-primary"><Wrench className="size-4" /> Start PDI</button></div></form>}

              {unit.status === "pdi" && <form action={completePdi.bind(null, id)} className="rounded-2xl border border-border bg-background/30 p-4"><div className="flex items-center gap-2"><ClipboardCheck className="size-4 text-primary" /><p className="font-semibold">PDI checklist</p></div><div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{PDI_CHECKS.map(([name, label]) => <label key={name} className="flex items-center gap-2 rounded-xl border border-border bg-card/60 px-3 py-2.5 text-sm"><input type="checkbox" name={name} required /> {label}</label>)}</div><textarea name="notes" className="input mt-3 min-h-20" placeholder="PDI observations" /><button className="btn-primary mt-3"><CheckCircle2 className="size-4" /> Complete PDI and mark ready</button></form>}

              {unit.status === "ready" && <FeedbackBanner tone="success" title="Ready for delivery">Complete handover from Deliveries; stock, warranty and vehicle registration close atomically.</FeedbackBanner>}

              {allowed.length > 0 && <ModalTrigger label={<><PauseCircle className="size-4" /> Change operational state</>} title="Controlled status change" buttonClass="btn-secondary btn-sm"><form action={changeStockStatus.bind(null, id)} className="card space-y-3"><select name="toStatus" className="input" required defaultValue=""><option value="" disabled>Select status…</option>{allowed.map((target) => <option key={target} value={target}>{STOCK_STATUS_LABELS[target]}</option>)}</select><textarea name="reason" className="input min-h-24" required placeholder="Reason" /><button className="btn-primary w-full">Apply status</button></form></ModalTrigger>}

              {customStatuses.length > 0 && !COMMITTED.has(unit.status) && <ModalTrigger label="Apply custom label" title="Organisational stock label" buttonClass="btn-secondary btn-sm"><form action={setStockStatus.bind(null, id)} className="card space-y-3"><select name="status" className="input" required defaultValue=""><option value="" disabled>Select custom status…</option>{customStatuses.map((option) => <option key={option.slug} value={option.slug}>{option.label}</option>)}</select><textarea name="reason" className="input min-h-24" required placeholder="Reason for this label" /><button className="btn-primary w-full">Apply custom status</button></form></ModalTrigger>}
            </div>}
          </Surface>

          <Surface className="p-5">
            <SectionHeading title="Unit identity and condition" description="Identifiers, equipment, operating data and valuation." action={<Fingerprint className="size-5 text-primary" />} />
            <form action={updateStockUnit.bind(null, id)} className="mt-5 space-y-4"><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <div><label className="label">Stock number</label><input name="stockNumber" className="input font-mono uppercase" defaultValue={unit.stockNumber ?? ""} /></div><div><label className="label">Serial / VIN</label><input name="serial" className="input font-mono uppercase" defaultValue={unit.serial ?? ""} /></div><div><label className="label">Colour</label><input name="color" className="input" defaultValue={unit.color ?? ""} /></div>
              <div><label className="label">Location</label><select name="locationId" className="input" defaultValue={unit.locationId ?? ""}><option value="">Unassigned</option>{locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select></div><div><label className="label">Condition</label><select name="condition" className="input" defaultValue={unit.condition}><option value="new">New</option><option value="demo">Demo</option><option value="used">Used</option><option value="consignment">Consignment</option><option value="damaged">Damaged</option></select></div><div><label className="label">Manufacturing year</label><input name="manufacturingYear" type="number" min="2000" max="2100" className="input" defaultValue={unit.manufacturingYear ?? ""} /></div>
              <div><label className="label">Battery type</label><input name="batteryType" className="input" defaultValue={unit.batteryType ?? ""} /></div><div><label className="label">Battery serial</label><input name="batterySerial" className="input font-mono uppercase" defaultValue={unit.batterySerial ?? ""} /></div><div><label className="label">Charger serial</label><input name="chargerSerial" className="input font-mono uppercase" defaultValue={unit.chargerSerial ?? ""} /></div>
              <div><label className="label">Keys / remotes</label><input name="keyCount" type="number" min="0" className="input" defaultValue={unit.keyCount ?? ""} /></div><div><label className="label">Odometer (km)</label><input name="odometerKm" type="number" min="0" className="input" defaultValue={unit.odometerKm ?? ""} /></div><div><label className="label">Operating hours</label><input name="operatingHours" type="number" min="0" className="input" defaultValue={unit.operatingHours ?? ""} /></div>
              {canManage && <div><label className="label">Acquisition cost (R)</label><input name="cost" inputMode="decimal" className="input" defaultValue={(unit.costCents / 100).toFixed(2)} /></div>}{canManage && <div><label className="label">Landed cost (R)</label><input name="landedCost" inputMode="decimal" className="input" defaultValue={(landedCost / 100).toFixed(2)} /></div>}<div><label className="label">Consignment owner</label><input name="consignmentOwner" className="input" defaultValue={unit.consignmentOwner ?? ""} /></div>
            </div><div><label className="label">Internal notes</label><textarea name="notes" className="input min-h-28" defaultValue={unit.notes ?? ""} /></div>{canManage && <div><label className="label">Adjustment reason</label><input name="reason" className="input" placeholder="Context for cost or identity changes" /></div>}{canManage && <button className="btn-secondary">Save unit details</button>}</form>
          </Surface>

          <Surface className="p-5"><SectionHeading title="Photos and documents" description="Condition, serial plates, accessories and PDI evidence." action={<Camera className="size-5 text-primary" />} />{canManage && <form action={uploadStockFiles.bind(null, id)} className="mt-4 flex flex-col gap-3 rounded-2xl border border-dashed border-border bg-background/30 p-4 sm:flex-row sm:items-end"><div className="flex-1"><label className="label">Files</label><input type="file" name="files" multiple accept="image/*,.pdf" className="block w-full text-xs text-muted-foreground file:btn-secondary file:btn-sm file:mr-2 file:border-0" /></div><select name="category" className="input sm:w-44"><option value="photo">Photo</option><option value="serial">Serial plate</option><option value="condition">Condition report</option><option value="pdi">PDI evidence</option><option value="supplier">Supplier document</option></select><button className="btn-primary">Upload</button></form>}<div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{unit.attachments.map((file) => <a key={file.id} href={file.storedName} target="_blank" rel="noreferrer" className="rounded-2xl border border-border bg-background/30 p-4 hover:border-primary/30"><p className="truncate text-sm font-medium">{file.fileName}</p><p className="mt-1 text-xs text-muted-foreground">{file.category} · {(file.sizeBytes / 1024).toFixed(0)} KB</p></a>)}{unit.attachments.length === 0 && <p className="text-sm text-muted-foreground">No files added yet.</p>}</div></Surface>

          <Surface className="p-5"><SectionHeading title="Movement ledger" description="Append-only inventory history." action={<History className="size-5 text-primary" />} /><ol className="relative mt-5 space-y-4 border-l border-border pl-5">{unit.movements.map((movement) => <li key={movement.id} className="relative rounded-2xl border border-border bg-background/30 p-4 before:absolute before:-left-[25px] before:top-5 before:size-2 before:rounded-full before:bg-primary before:ring-4 before:ring-card"><div className="flex justify-between gap-3"><div><p className="font-medium capitalize">{movement.eventType.replaceAll("_", " ")}</p><p className="mt-1 text-xs text-muted-foreground">{movement.fromStatus ? `${movement.fromStatus} → ` : ""}{movement.toStatus ?? "record updated"}</p></div><p className="text-[10px] text-muted-foreground">{formatDateTime(movement.occurredAt)}</p></div>{movement.reason && <p className="mt-2 text-sm text-muted-foreground">{movement.reason}</p>}<p className="mt-3 text-[10px] text-muted-foreground">{movement.performedByName}{movement.costAfterCents != null ? ` · ${formatZAR(movement.costAfterCents)}` : ""}</p></li>)}</ol></Surface>
        </div>

        <aside className="space-y-5 xl:sticky xl:top-6 xl:self-start">
          <Surface className="p-5"><SectionHeading title="Unit facts" description="Operational identifiers at a glance." /><dl className="mt-4 space-y-3 text-sm">{facts.map(({ label, value, icon: Icon }) => <div key={label} className="flex items-start gap-3 rounded-xl border border-border bg-background/30 p-3"><Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><div><dt className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">{label}</dt><dd className="mt-1 break-words font-medium">{value}</dd></div></div>)}</dl></Surface>
          {unit.purchaseOrderReference && <Surface className="p-5" inset><SectionHeading title="Supplier origin" description="Received through purchasing." /><p className="mt-4 font-medium">{unit.purchaseOrderReference}</p><Link href="/stock/purchase-orders" className="mt-3 inline-flex items-center gap-2 text-xs font-medium text-primary hover:underline"><Truck className="size-3.5" /> Purchase orders</Link></Surface>}
          {unit.status === "delivered" && <Surface className="border-emerald-400/20 bg-emerald-400/5 p-5"><SectionHeading title="Delivery complete" description="Customer vehicle created automatically." action={<CheckCircle2 className="size-5 text-emerald-300" />} />{unit.warrantyExpiresAt && <p className="mt-4 text-xs text-emerald-100/70">Warranty through {unit.warrantyExpiresAt.toLocaleDateString("en-ZA")}</p>}</Surface>}
          {canManage && !COMMITTED.has(unit.status) && <Surface className="border-red-400/20 p-5"><SectionHeading title="Archive unit" description="Remove from active stock while retaining history." action={<AlertTriangle className="size-5 text-red-300" />} /><form action={deleteStockUnit.bind(null, id)} className="mt-4 space-y-3"><textarea name="reason" required className="input min-h-20" placeholder="Archive reason" /><button className="btn-danger w-full">Archive stock unit</button></form></Surface>}
        </aside>
      </div>
    </div>
  );
}
