import Link from "next/link";
import { notFound } from "next/navigation";
import { format, startOfDay } from "date-fns";
import {
  Camera,
  CheckCircle2,
  FileText,
  Gauge,
  MapPin,
  ShieldCheck,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import { prisma } from "@/lib/db";
import { contactName, formatDateTime } from "@/lib/format";
import { getAccessibleQuoteIds, hasPermission } from "@/lib/permissions";
import { requireTestDriveReadAccess } from "@/lib/testDriveAccess";
import { listTenantStaff } from "@/lib/tenantActor";
import { testDriveStatusLabel } from "@/lib/testDriveMetrics";
import {
  cancelTestDrive,
  checkOutTestDrive,
  completeTestDrive,
  confirmTestDrive,
  markTestDriveNoShow,
  saveDriverControls,
  updateTestDriveBooking,
  uploadTestDriveAsset,
} from "@/app/actions/testDrives";
import { PageHeader } from "@/components/page-header";
import { Surface } from "@/components/visual-system";

export const dynamic = "force-dynamic";

const inputDate = (date: Date) => format(date, "yyyy-MM-dd'T'HH:mm");
const inputDay = (date: Date | null) => date ? format(date, "yyyy-MM-dd") : "";

const statusClass: Record<string, string> = {
  booked: "bg-blue-500/15 text-blue-300",
  confirmed: "bg-emerald-500/15 text-emerald-300",
  checked_out: "bg-amber-500/15 text-amber-300",
  completed: "bg-emerald-500/15 text-emerald-300",
  cancelled: "bg-muted text-muted-foreground",
  no_show: "bg-red-500/15 text-red-300",
};

export default async function TestDriveDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireTestDriveReadAccess(id);
  const [canManage, accessibleQuoteIds] = await Promise.all([
    hasPermission(user, "activities.manage"),
    getAccessibleQuoteIds(user),
  ]);
  const quoteScope = accessibleQuoteIds === null ? {} : { id: { in: accessibleQuoteIds } };
  const booking = await prisma.testDriveBooking.findFirst({
    where: { id, deletedAt: null },
    include: { demoVehicle: true, assets: { orderBy: { createdAt: "desc" } } },
  });
  if (!booking) notFound();

  const [contact, lead, product, demos, staff, quotes] = await Promise.all([
    prisma.contact.findUnique({ where: { id: booking.contactId } }),
    booking.leadId ? prisma.lead.findUnique({ where: { id: booking.leadId } }) : null,
    booking.productId ? prisma.product.findUnique({ where: { id: booking.productId } }) : null,
    prisma.demoVehicle.findMany({
      where: { deletedAt: null, status: { in: ["active", "maintenance", "unavailable"] } },
      orderBy: { name: "asc" },
    }),
    listTenantStaff(),
    prisma.quote.findMany({
      where: { contactId: booking.contactId, deletedAt: null, ...quoteScope },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, number: true, status: true },
    }),
  ]);
  if (!contact) notFound();

  const staffMap = new Map(staff.map((member) => [member.id, member.name]));
  const salespersonName = staffMap.get(booking.salespersonId) ?? "Unavailable user";
  const accompanyingName = booking.accompanyingSalespersonId
    ? staffMap.get(booking.accompanyingSalespersonId) ?? "Unavailable user"
    : null;
  const upcoming = ["booked", "confirmed"].includes(booking.status);
  const isImage = (mimeType: string) => mimeType.startsWith("image/");
  const assetsFor = (kind: string) => booking.assets.filter((asset) => asset.kind === kind);
  const licenceAssets = assetsFor("driver_licence");
  const startConditionAssets = assetsFor("start_condition");
  const licenceValid = Boolean(
    booking.driverLicenceExpiry && booking.driverLicenceExpiry >= startOfDay(new Date()),
  );
  const readyForCheckout = Boolean(
    booking.demoVehicleId &&
    booking.driverLicenceNumber &&
    licenceValid &&
    booking.identityVerifiedAt &&
    booking.indemnityStatus !== "pending" &&
    booking.emergencyContactName &&
    booking.emergencyContactPhone &&
    licenceAssets.length > 0 &&
    startConditionAssets.length > 0
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={booking.reference}
        description={`${contactName(contact)} · ${product?.name ?? booking.demoVehicle?.name ?? "Test drive"} · ${formatDateTime(booking.scheduledStart)}`}
      >
        <Link href="/test-drives" className="btn-secondary btn-sm">Back to test drives</Link>
        <span className={`badge ${statusClass[booking.status] ?? "bg-muted text-muted-foreground"}`}>
          {testDriveStatusLabel(booking.status)}
        </span>
      </PageHeader>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Surface className="p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Customer</p>
          <p className="mt-1 font-medium">{contactName(contact)}</p>
          {lead && <Link href={`/leads/${lead.id}`} className="text-xs text-primary hover:underline">{lead.title}</Link>}
        </Surface>
        <Surface className="p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Vehicle</p>
          <p className="mt-1 font-medium">{booking.demoVehicle?.name ?? "Not assigned"}</p>
          <p className="text-xs text-muted-foreground">{booking.demoVehicle?.regNumber ?? product?.name ?? "Model not set"}</p>
        </Surface>
        <Surface className="p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Schedule</p>
          <p className="mt-1 font-medium">{formatDateTime(booking.scheduledStart)}</p>
          <p className="text-xs text-muted-foreground">Expected back {formatDateTime(booking.expectedReturnAt)}</p>
        </Surface>
        <Surface className="p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Salesperson</p>
          <p className="mt-1 font-medium">{salespersonName}</p>
          <p className="text-xs text-muted-foreground">{accompanyingName ? `Accompanied by ${accompanyingName}` : booking.branch}</p>
        </Surface>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <main className="space-y-5">
          <Surface className="p-5">
            <div className="flex items-center gap-2">
              <MapPin className="size-4 text-primary" />
              <h2 className="font-semibold">Booking and vehicle assignment</h2>
            </div>
            {canManage && upcoming ? (
              <form action={updateTestDriveBooking.bind(null, booking.id)} className="mt-4 grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="label">Branch / location</label>
                  <input name="branch" className="input" required defaultValue={booking.branch} />
                </div>
                <div>
                  <label className="label">Demo vehicle</label>
                  <select name="demoVehicleId" className="input" defaultValue={booking.demoVehicleId ?? ""}>
                    <option value="">Assign later</option>
                    {demos.map((demo) => <option key={demo.id} value={demo.id}>{demo.name} · {demo.status}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Salesperson</label>
                  <select name="salespersonId" className="input" defaultValue={booking.salespersonId}>
                    {staff.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Accompanying salesperson</label>
                  <select name="accompanyingSalespersonId" className="input" defaultValue={booking.accompanyingSalespersonId ?? ""}>
                    <option value="">None</option>
                    {staff.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Start</label>
                  <input type="datetime-local" name="scheduledStart" className="input" required defaultValue={inputDate(booking.scheduledStart)} />
                </div>
                <div>
                  <label className="label">Expected return</label>
                  <input type="datetime-local" name="expectedReturnAt" className="input" required defaultValue={inputDate(booking.expectedReturnAt)} />
                </div>
                <div className="sm:col-span-2 text-right"><button className="btn-secondary btn-sm">Save booking</button></div>
              </form>
            ) : (
              <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                <p><span className="text-muted-foreground">Branch:</span> {booking.branch}</p>
                <p><span className="text-muted-foreground">Vehicle:</span> {booking.demoVehicle?.name ?? "Not assigned"}</p>
              </div>
            )}
          </Surface>

          <Surface className="p-5">
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-primary" />
              <h2 className="font-semibold">Driver controls</h2>
            </div>
            <form action={saveDriverControls.bind(null, booking.id)} className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label">Driver&apos;s licence number</label>
                <input name="driverLicenceNumber" className="input" required defaultValue={booking.driverLicenceNumber ?? ""} disabled={!canManage || !upcoming} />
              </div>
              <div>
                <label className="label">Licence expiry</label>
                <input type="date" name="driverLicenceExpiry" className="input" required defaultValue={inputDay(booking.driverLicenceExpiry)} disabled={!canManage || !upcoming} />
              </div>
              <div>
                <label className="label">Emergency contact</label>
                <input name="emergencyContactName" className="input" required defaultValue={booking.emergencyContactName ?? ""} disabled={!canManage || !upcoming} />
              </div>
              <div>
                <label className="label">Emergency phone</label>
                <input name="emergencyContactPhone" className="input" required defaultValue={booking.emergencyContactPhone ?? ""} disabled={!canManage || !upcoming} />
              </div>
              <div>
                <label className="label">Indemnity</label>
                <select name="indemnityStatus" className="input" defaultValue={booking.indemnityStatus} disabled={!canManage || !upcoming}>
                  <option value="pending">Pending</option>
                  <option value="signed">Signed</option>
                  <option value="waived">Waived</option>
                  <option value="not_required">Not required</option>
                </select>
              </div>
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <input type="checkbox" name="identityVerified" defaultChecked={Boolean(booking.identityVerifiedAt)} disabled={!canManage || !upcoming} />
                Identity verified
              </label>
              {canManage && upcoming && <div className="sm:col-span-2 text-right"><button className="btn-secondary btn-sm">Save driver controls</button></div>}
            </form>
            <AssetUploader bookingId={booking.id} kind="driver_licence" label="Upload licence or ID" disabled={!canManage || !upcoming} />
            <AssetGrid assets={licenceAssets} isImage={isImage} />
          </Surface>

          <Surface className="p-5">
            <div className="flex items-center gap-2">
              <Gauge className="size-4 text-primary" />
              <h2 className="font-semibold">Vehicle handover</h2>
            </div>
            {booking.status === "checked_out" || booking.status === "completed" ? (
              <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                <p><span className="text-muted-foreground">Start odometer:</span> {booking.startOdometerKm ?? "—"} km</p>
                <p><span className="text-muted-foreground">Start battery:</span> {booking.startBatteryPct ?? "—"}%</p>
                <p className="sm:col-span-2"><span className="text-muted-foreground">Existing damage:</span> {booking.existingDamage ?? "None recorded"}</p>
                <p><span className="text-muted-foreground">Accessories:</span> {booking.accessoriesSupplied ?? "None recorded"}</p>
                <p><span className="text-muted-foreground">Route:</span> {booking.intendedRoute ?? "Not recorded"}</p>
              </div>
            ) : canManage && upcoming ? (
              <form action={checkOutTestDrive.bind(null, booking.id)} className="mt-4 grid gap-3 sm:grid-cols-2">
                {!readyForCheckout && (
                  <div className="sm:col-span-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200">
                    Complete every item in the readiness checklist before vehicle handover.
                  </div>
                )}
                <div>
                  <label className="label">Start odometer (km)</label>
                  <input type="number" min="0" name="startOdometerKm" className="input" required defaultValue={booking.demoVehicle?.odometerKm ?? ""} />
                </div>
                <div>
                  <label className="label">Start battery (%)</label>
                  <input type="number" min="0" max="100" name="startBatteryPct" className="input" defaultValue={booking.demoVehicle?.batteryLevelPct ?? ""} />
                </div>
                <div className="sm:col-span-2">
                  <label className="label">Existing damage</label>
                  <textarea name="existingDamage" className="input" rows={2} placeholder="Scratches, dents or other existing damage" />
                </div>
                <div>
                  <label className="label">Accessories supplied</label>
                  <input name="accessoriesSupplied" className="input" placeholder="Keys, charger, documents…" />
                </div>
                <div>
                  <label className="label">Route / destination</label>
                  <input name="intendedRoute" className="input" placeholder="Intended route or destination" />
                </div>
                <div className="sm:col-span-2">
                  <button className="btn-primary w-full" disabled={!readyForCheckout}>Check vehicle out</button>
                </div>
              </form>
            ) : <p className="mt-4 text-sm text-muted-foreground">The handover was not completed.</p>}
            <AssetUploader bookingId={booking.id} kind="start_condition" label="Add start-condition photos" disabled={!canManage || !upcoming} />
            <AssetGrid assets={startConditionAssets} isImage={isImage} />
          </Surface>

          <Surface className="p-5">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="size-4 text-primary" />
              <h2 className="font-semibold">Return and sales outcome</h2>
            </div>
            {booking.status === "completed" ? (
              <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                <p><span className="text-muted-foreground">Return odometer:</span> {booking.returnOdometerKm ?? "—"} km</p>
                <p><span className="text-muted-foreground">Return battery:</span> {booking.returnBatteryPct ?? "—"}%</p>
                <p className="sm:col-span-2"><span className="text-muted-foreground">Condition:</span> {booking.returnCondition ?? "Not recorded"}</p>
                <p className="sm:col-span-2"><span className="text-muted-foreground">New damage:</span> {booking.newDamage ?? "None recorded"}</p>
                <p className="sm:col-span-2"><span className="text-muted-foreground">Feedback:</span> {booking.customerFeedback ?? "None recorded"}</p>
                <p><span className="text-muted-foreground">Outcome:</span> {booking.salesOutcome?.replaceAll("_", " ") ?? "Undecided"}</p>
                {booking.convertedQuoteId && <Link href={`/quotes/${booking.convertedQuoteId}`} className="text-primary hover:underline">Open converted quote</Link>}
              </div>
            ) : booking.status === "checked_out" && canManage ? (
              <form action={completeTestDrive.bind(null, booking.id)} className="mt-4 grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="label">Return odometer (km)</label>
                  <input type="number" min={booking.startOdometerKm ?? 0} name="returnOdometerKm" className="input" required />
                </div>
                <div>
                  <label className="label">Return battery (%)</label>
                  <input type="number" min="0" max="100" name="returnBatteryPct" className="input" />
                </div>
                <div className="sm:col-span-2"><label className="label">Return condition</label><textarea name="returnCondition" className="input" rows={2} /></div>
                <div className="sm:col-span-2"><label className="label">New damage</label><textarea name="newDamage" className="input" rows={2} /></div>
                <div className="sm:col-span-2"><label className="label">Incident report</label><textarea name="incidentReport" className="input" rows={3} /></div>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="cleaningRequired" /> Cleaning required</label>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="chargingRequired" /> Charging required</label>
                <div>
                  <label className="label">Sales outcome</label>
                  <select name="salesOutcome" className="input" defaultValue="undecided">
                    <option value="undecided">Undecided</option>
                    <option value="follow_up">Follow-up required</option>
                    <option value="quote_created">Quote created</option>
                    <option value="sale_won">Sale won</option>
                    <option value="no_interest">No interest</option>
                  </select>
                </div>
                <div>
                  <label className="label">Converted quote</label>
                  <select name="convertedQuoteId" className="input" defaultValue="">
                    <option value="">None</option>
                    {quotes.map((quote) => <option key={quote.id} value={quote.id}>Q-{quote.number} · {quote.status}</option>)}
                  </select>
                </div>
                <div className="sm:col-span-2"><label className="label">Customer feedback</label><textarea name="customerFeedback" className="input" rows={3} /></div>
                <div className="sm:col-span-2"><button className="btn-primary w-full">Complete return</button></div>
              </form>
            ) : <p className="mt-4 text-sm text-muted-foreground">Return controls become available after vehicle check-out.</p>}
            <AssetUploader bookingId={booking.id} kind="return_condition" label="Add return-condition photos" disabled={!canManage || !["checked_out", "completed"].includes(booking.status)} />
            <AssetUploader bookingId={booking.id} kind="incident" label="Add incident evidence" disabled={!canManage || !["checked_out", "completed"].includes(booking.status)} />
            <AssetGrid assets={[...assetsFor("return_condition"), ...assetsFor("incident")]} isImage={isImage} />
          </Surface>
        </main>

        <aside className="space-y-4">
          <Surface className="p-5">
            <div className="flex items-center gap-2">
              <UserRound className="size-4 text-primary" />
              <h2 className="font-semibold">Readiness</h2>
            </div>
            <ul className="mt-4 space-y-2 text-sm">
              <ReadyRow ready={Boolean(booking.demoVehicleId)} label="Demo vehicle assigned" />
              <ReadyRow ready={Boolean(booking.driverLicenceNumber)} label="Licence number captured" />
              <ReadyRow ready={licenceValid} label="Licence is current" />
              <ReadyRow ready={licenceAssets.length > 0} label="Licence / ID evidence" />
              <ReadyRow ready={Boolean(booking.identityVerifiedAt)} label="Identity verified" />
              <ReadyRow ready={booking.indemnityStatus !== "pending"} label="Indemnity complete" />
              <ReadyRow ready={Boolean(booking.emergencyContactName && booking.emergencyContactPhone)} label="Emergency contact" />
              <ReadyRow ready={startConditionAssets.length > 0} label="Condition photos" />
            </ul>
          </Surface>

          {canManage && upcoming && (
            <Surface className="space-y-3 p-5">
              <h2 className="font-semibold">Booking controls</h2>
              {booking.status === "booked" && (
                <form action={confirmTestDrive.bind(null, booking.id)}>
                  <button className="btn-primary w-full">Confirm booking</button>
                </form>
              )}
              <form action={markTestDriveNoShow.bind(null, booking.id)} className="space-y-2">
                <input name="reason" className="input" placeholder="No-show note (optional)" />
                <button className="btn-secondary w-full">Mark no-show</button>
              </form>
              <form action={cancelTestDrive.bind(null, booking.id)} className="space-y-2">
                <textarea name="reason" className="input" rows={2} required placeholder="Cancellation reason" />
                <button className="btn-danger w-full">Cancel booking</button>
              </form>
            </Surface>
          )}

          {(booking.newDamage || booking.incidentReport) && (
            <Surface className="border-red-500/30 p-5">
              <div className="flex items-center gap-2 text-red-300">
                <TriangleAlert className="size-4" />
                <h2 className="font-semibold">Incident recorded</h2>
              </div>
              {booking.newDamage && <p className="mt-3 text-sm">{booking.newDamage}</p>}
              {booking.incidentReport && <p className="mt-2 text-sm text-muted-foreground">{booking.incidentReport}</p>}
            </Surface>
          )}
        </aside>
      </div>
    </div>
  );
}

function ReadyRow({ ready, label }: { ready: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2">
      <span className={`grid size-5 place-items-center rounded-full text-xs ${ready ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/15 text-amber-300"}`}>
        {ready ? "✓" : "!"}
      </span>
      {label}
    </li>
  );
}

function AssetUploader({ bookingId, kind, label, disabled }: { bookingId: string; kind: string; label: string; disabled: boolean }) {
  if (disabled) return null;
  return (
    <form action={uploadTestDriveAsset.bind(null, bookingId, kind)} className="mt-4 flex flex-col gap-2 rounded-xl border border-dashed border-border p-3 sm:flex-row">
      <input type="file" name="file" required accept="image/jpeg,image/png,image/webp,application/pdf" className="min-w-0 flex-1 text-xs" />
      <input name="note" className="input h-9 sm:w-48" placeholder="Optional note" />
      <button className="btn-secondary btn-sm"><Camera className="size-4" />{label}</button>
    </form>
  );
}

function AssetGrid({ assets, isImage }: { assets: Array<{ id: string; fileName: string; mimeType: string; note: string | null }>; isImage: (mimeType: string) => boolean }) {
  if (!assets.length) return null;
  return (
    <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {assets.map((asset) => (
        <a key={asset.id} href={`/api/test-drives/assets/${asset.id}`} target="_blank" rel="noreferrer" className="overflow-hidden rounded-xl border border-border bg-background/40 hover:border-primary/40">
          {isImage(asset.mimeType) ? (
            // Authenticated evidence routes cannot use Next Image optimisation.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/test-drives/assets/${asset.id}`} alt={asset.note ?? asset.fileName} className="h-32 w-full object-cover" />
          ) : (
            <div className="grid h-32 place-items-center"><FileText className="size-8 text-muted-foreground" /></div>
          )}
          <div className="p-3">
            <p className="truncate text-xs font-medium">{asset.fileName}</p>
            {asset.note && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{asset.note}</p>}
          </div>
        </a>
      ))}
    </div>
  );
}
