import Link from "next/link";
import { addHours, addDays, differenceInCalendarDays, format, startOfDay, subDays } from "date-fns";
import { CalendarDays, CarFront, Gauge, Plus, Route, TriangleAlert, UserCheck } from "lucide-react";
import { prisma } from "@/lib/db";
import { contactName, formatDateTime } from "@/lib/format";
import {
  getAccessibleContactIds,
  getAccessibleLeadIds,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";
import { accessibleTestDriveWhere } from "@/lib/testDriveAccess";
import { listTenantStaff } from "@/lib/tenantActor";
import { calculateTestDriveMetrics, testDriveStatusLabel } from "@/lib/testDriveMetrics";
import { createTestDriveBooking } from "@/app/actions/testDrives";
import ModalTrigger from "@/components/Modal";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState, MetricCard, Surface } from "@/components/visual-system";

export const dynamic = "force-dynamic";

type SearchParams = { status?: string };

const statusClass: Record<string, string> = {
  booked: "bg-blue-500/15 text-blue-300",
  confirmed: "bg-emerald-500/15 text-emerald-300",
  checked_out: "bg-amber-500/15 text-amber-300",
  completed: "bg-emerald-500/15 text-emerald-300",
  cancelled: "bg-muted text-muted-foreground",
  no_show: "bg-red-500/15 text-red-300",
};

const inputDate = (date: Date) => format(date, "yyyy-MM-dd'T'HH:mm");

export default async function TestDrivesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requireAnyPermission("activities.view", "activities.manage");
  const canManage = await hasPermission(user, "activities.manage");
  const { status } = await searchParams;
  const now = new Date();
  const metricFrom = subDays(startOfDay(now), 29);
  const [bookingScope, accessibleContactIds, accessibleLeadIds] = await Promise.all([
    accessibleTestDriveWhere(user),
    getAccessibleContactIds(user),
    getAccessibleLeadIds(user),
  ]);
  const canCreate = canManage && (accessibleContactIds === null || accessibleContactIds.length > 0);
  const contactScope = accessibleContactIds === null ? {} : { id: { in: accessibleContactIds } };
  const leadScope = accessibleLeadIds === null ? {} : { id: { in: accessibleLeadIds } };

  const [bookings, metricBookings, activeDemoVehicleCount, eligibleLeadCount, contacts, leads, demos, products, staff] = await Promise.all([
    prisma.testDriveBooking.findMany({
      where: { deletedAt: null, ...bookingScope, ...(status ? { status } : {}) },
      include: { demoVehicle: true },
      orderBy: { scheduledStart: "desc" },
      take: 200,
    }),
    prisma.testDriveBooking.findMany({
      where: { deletedAt: null, ...bookingScope, scheduledStart: { gte: metricFrom, lte: addDays(now, 1) } },
      select: {
        leadId: true,
        status: true,
        scheduledStart: true,
        expectedReturnAt: true,
        actualStartAt: true,
        actualReturnAt: true,
        convertedQuoteId: true,
        salesOutcome: true,
        newDamage: true,
        incidentReport: true,
      },
    }),
    prisma.demoVehicle.count({ where: { deletedAt: null, status: "active" } }),
    prisma.lead.count({ where: { deletedAt: null, ...leadScope, createdAt: { gte: metricFrom, lte: now } } }),
    prisma.contact.findMany({ where: { deletedAt: null, ...contactScope }, orderBy: { firstName: "asc" }, take: 500 }),
    prisma.lead.findMany({ where: { deletedAt: null, ...leadScope, status: "open" }, orderBy: { createdAt: "desc" }, take: 500, select: { id: true, title: true, name: true, contactId: true, productId: true } }),
    prisma.demoVehicle.findMany({ where: { deletedAt: null, status: "active" }, orderBy: { name: "asc" } }),
    prisma.product.findMany({ where: { deletedAt: null, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    listTenantStaff(),
  ]);

  const metrics = calculateTestDriveMetrics({
    bookings: metricBookings,
    eligibleLeadCount,
    activeDemoVehicleCount,
    periodDays: Math.max(1, differenceInCalendarDays(now, metricFrom) + 1),
  });

  const contactIds = [...new Set(bookings.map((booking) => booking.contactId))];
  const leadIds = [...new Set(bookings.map((booking) => booking.leadId).filter(Boolean) as string[])];
  const productIds = [...new Set(bookings.map((booking) => booking.productId).filter(Boolean) as string[])];
  const [bookingContacts, bookingLeads, bookingProducts] = await Promise.all([
    prisma.contact.findMany({ where: { id: { in: contactIds } }, select: { id: true, firstName: true, lastName: true, company: true, isCompany: true } }),
    prisma.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, title: true } }),
    prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true } }),
  ]);
  const contactMap = new Map(bookingContacts.map((contact) => [contact.id, contactName(contact)]));
  const leadMap = new Map(bookingLeads.map((lead) => [lead.id, lead.title]));
  const productMap = new Map(bookingProducts.map((product) => [product.id, product.name]));
  const staffMap = new Map(staff.map((member) => [member.id, member.name]));

  const defaultStart = addHours(now, 24);
  defaultStart.setMinutes(0, 0, 0);
  const defaultEnd = addHours(defaultStart, 1);

  return (
    <div className="space-y-6">
      <PageHeader title="Test drives" description="Book, control and measure every customer drive from vehicle assignment to return.">
        <Link href="/test-drives/demo-fleet" className={buttonVariants({ variant: "secondary", size: "sm" })}>
          <CarFront className="size-4" /> Demo fleet
        </Link>
        {canCreate && (
          <ModalTrigger
            label={<><Plus className="size-4" />Book test drive</>}
            title="Book a test drive"
            buttonClass={buttonVariants({ size: "sm" })}
          >
            <form action={createTestDriveBooking} className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label className="label">Customer</label>
                  <select name="contactId" className="input" required defaultValue="">
                    <option value="" disabled>Select customer…</option>
                    {contacts.map((contact) => <option key={contact.id} value={contact.id}>{contactName(contact)}</option>)}
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label className="label">Lead</label>
                  <select name="leadId" className="input" defaultValue="">
                    <option value="">No linked lead</option>
                    {leads.map((lead) => <option key={lead.id} value={lead.id}>{lead.title} — {lead.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Branch / location</label>
                  <input name="branch" className="input" required placeholder="Cape Town showroom" />
                </div>
                <div>
                  <label className="label">Demo vehicle</label>
                  <select name="demoVehicleId" className="input" defaultValue="">
                    <option value="">Assign later</option>
                    {demos.map((demo) => <option key={demo.id} value={demo.id}>{demo.name}{demo.regNumber ? ` · ${demo.regNumber}` : ""}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Model</label>
                  <select name="productId" className="input" defaultValue="">
                    <option value="">Infer from lead or demo vehicle</option>
                    {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Salesperson</label>
                  <select name="salespersonId" className="input" defaultValue={user.id}>
                    {staff.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Accompanying salesperson</label>
                  <select name="accompanyingSalespersonId" className="input" defaultValue="">
                    <option value="">None</option>
                    {staff.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Start</label>
                  <input type="datetime-local" name="scheduledStart" className="input" required defaultValue={inputDate(defaultStart)} />
                </div>
                <div>
                  <label className="label">Expected return</label>
                  <input type="datetime-local" name="expectedReturnAt" className="input" required defaultValue={inputDate(defaultEnd)} />
                </div>
              </div>
              <button className="btn-primary w-full">Create booking</button>
            </form>
          </ModalTrigger>
        )}
      </PageHeader>

      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard icon={CalendarDays} label="Bookings · 30 days" value={metrics.bookings} detail={`${metrics.bookedLeads} unique leads · ${metrics.bookingRate}% booking rate`} />
        <MetricCard icon={UserCheck} label="Attendance" value={`${metrics.attendanceRate}%`} detail={`${metrics.attended} attended · ${metrics.noShows} no-shows`} />
        <MetricCard icon={Route} label="Quote conversion" value={`${metrics.quoteConversionRate}%`} detail={`${metrics.saleConversionRate}% of attended drives became sales`} />
        <MetricCard icon={TriangleAlert} label="Incidents" value={`${metrics.incidentRate}%`} detail={`${metrics.incidents} damage / incident records`} accent={metrics.incidents > 0} />
      </section>

      <Surface className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</span>
          {["", "booked", "confirmed", "checked_out", "completed", "cancelled", "no_show"].map((value) => (
            <Link
              key={value || "all"}
              href={value ? `/test-drives?status=${value}` : "/test-drives"}
              className={`rounded-full border px-3 py-1 text-xs ${status === value || (!status && !value) ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
            >
              {value ? testDriveStatusLabel(value) : "All"}
            </Link>
          ))}
          <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground"><Gauge className="size-3.5" />Demo utilisation: {metrics.utilisationRate}% · {metrics.bookedHours} booked hours</span>
        </div>
      </Surface>

      {bookings.length === 0 ? (
        <EmptyState icon={CalendarDays} title="No test drives in this view" description="Book a customer drive or choose another status filter." />
      ) : (
        <Surface className="overflow-x-auto p-0">
          <table className="table-base">
            <thead><tr><th>Booking</th><th>Customer</th><th>Vehicle</th><th>Schedule</th><th>Salesperson</th><th>Status</th></tr></thead>
            <tbody>
              {bookings.map((booking) => (
                <tr key={booking.id}>
                  <td>
                    <Link href={`/test-drives/${booking.id}`} className="font-medium text-primary hover:underline">{booking.reference}</Link>
                    {booking.leadId && <p className="max-w-56 truncate text-xs text-muted-foreground">{leadMap.get(booking.leadId) ?? "Linked lead"}</p>}
                  </td>
                  <td>{contactMap.get(booking.contactId) ?? "Customer"}</td>
                  <td>
                    <p>{booking.demoVehicle?.name ?? (booking.productId ? productMap.get(booking.productId) : null) ?? "Not assigned"}</p>
                    <p className="text-xs text-muted-foreground">{booking.branch}</p>
                  </td>
                  <td>
                    <p>{formatDateTime(booking.scheduledStart)}</p>
                    <p className="text-xs text-muted-foreground">Return {format(booking.expectedReturnAt, "HH:mm")}</p>
                  </td>
                  <td>{staffMap.get(booking.salespersonId) ?? "Unavailable user"}</td>
                  <td><span className={`badge ${statusClass[booking.status] ?? "bg-muted text-muted-foreground"}`}>{testDriveStatusLabel(booking.status)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Surface>
      )}
    </div>
  );
}
