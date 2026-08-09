import Link from "next/link";
import { addHours, addDays, differenceInCalendarDays, format, startOfDay, subDays } from "date-fns";
import { CalendarDays, CarFront, Gauge, Route, TriangleAlert, UserCheck } from "lucide-react";
import { prisma } from "@/lib/db";
import { contactName, formatDateTime, inputDateTimeValue } from "@/lib/format";
import {
  getAccessibleContactIds,
  getAccessibleLeadIds,
  hasPermission,
  requireAnyPermission,
} from "@/lib/permissions";
import { accessibleTestDriveWhere } from "@/lib/testDriveAccess";
import { listTenantStaff } from "@/lib/tenantActor";
import { calculateTestDriveMetrics, testDriveStatusLabel } from "@/lib/testDriveMetrics";
import { buttonVariants } from "@/components/ui/button";
import { TestDriveBookingTrigger } from "@/components/test-drives/TestDriveBookingTrigger";
import { EmptyState, SectionHeading, StatusPill, Surface } from "@/components/visual-system";
import { ResponsiveEntityTable } from "@/components/responsive-patterns";
import {
  DesktopOnly,
  MobileOnly,
  MobileSection,
  MobileSegmentNav,
  MobileStatPair,
  MobileTaskCard,
  MobileTaskList,
  MobileWorkspaceHeader,
} from "@/components/mobile-workspace";
import { WorkspaceHero } from "@/components/workspace-hero";

export const dynamic = "force-dynamic";

type SearchParams = { status?: string };

const statusTone: Record<string, "neutral" | "success" | "warning" | "danger" | "info"> = {
  booked: "info",
  confirmed: "success",
  checked_out: "warning",
  completed: "success",
  cancelled: "neutral",
  no_show: "danger",
};

// Pinned to Africa/Johannesburg — see lib/format.ts. date-fns format() would
// use the server timezone and seed this field two hours early.
const inputDate = inputDateTimeValue;

const TEST_DRIVE_FILTERS = ["", "booked", "confirmed", "checked_out", "completed", "cancelled", "no_show"] as const;

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

  const [bookings, metricBookings, activeDemoVehicleCount, eligibleLeads, contacts, leads, demos, products, staff] = await Promise.all([
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
    prisma.lead.findMany({
      where: { deletedAt: null, ...leadScope, createdAt: { gte: metricFrom, lte: now } },
      select: { id: true },
    }),
    prisma.contact.findMany({ where: { deletedAt: null, ...contactScope }, orderBy: { firstName: "asc" }, take: 500 }),
    prisma.lead.findMany({ where: { deletedAt: null, ...leadScope, status: "open" }, orderBy: { createdAt: "desc" }, take: 500, select: { id: true, title: true, name: true, contactId: true, productId: true } }),
    prisma.demoVehicle.findMany({ where: { deletedAt: null, status: "active" }, orderBy: { name: "asc" } }),
    prisma.product.findMany({ where: { deletedAt: null, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    listTenantStaff(),
  ]);

  const metrics = calculateTestDriveMetrics({
    bookings: metricBookings,
    eligibleLeadIds: eligibleLeads.map((lead) => lead.id),
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
    <>
      <MobileOnly className="space-y-4">
        <MobileWorkspaceHeader
          title="Test drives"
          description="Check today’s handovers and returns. Open a booking to capture the outcome."
          action={canCreate ? (
            <TestDriveBookingTrigger
              contacts={contacts}
              leads={leads}
              demos={demos}
              products={products}
              staff={staff}
              salespersonId={user.id}
              defaultStart={inputDate(defaultStart)}
              defaultEnd={inputDate(defaultEnd)}
              compact
            />
          ) : undefined}
        />
        <MobileStatPair items={[
          { label: "Bookings · 30 days", value: metrics.bookings },
          { label: "Incidents", value: metrics.incidents, tone: metrics.incidents > 0 ? "attention" : "default" },
        ]} />
        <MobileSegmentNav items={[
          ...TEST_DRIVE_FILTERS.map((value) => ({
            label: value ? testDriveStatusLabel(value) : "All",
            href: value ? `/test-drives?status=${value}` : "/test-drives",
            active: status === value || (!status && !value),
          })),
          { label: "Fleet", href: "/test-drives/demo-fleet" },
        ]} />
        <MobileSection title="Drive queue" detail={`${bookings.length} booking${bookings.length === 1 ? "" : "s"}`}>
          {bookings.length === 0 ? (
            <EmptyState icon={CalendarDays} title="No drives here" description="Choose another status or capture a new booking." />
          ) : (
            <MobileTaskList>
              {bookings.map((booking) => (
                <MobileTaskCard
                  key={booking.id}
                  icon={CarFront}
                  title={contactMap.get(booking.contactId) ?? "Customer"}
                  detail={`${booking.reference} · ${booking.demoVehicle?.name ?? (booking.productId ? productMap.get(booking.productId) : null) ?? "Vehicle not assigned"}`}
                  meta={`${formatDateTime(booking.scheduledStart)} · ${booking.branch}`}
                  aside={<StatusPill tone={statusTone[booking.status] ?? "neutral"}>{testDriveStatusLabel(booking.status)}</StatusPill>}
                  href={`/test-drives/${booking.id}`}
                />
              ))}
            </MobileTaskList>
          )}
        </MobileSection>
      </MobileOnly>

      <DesktopOnly className="space-y-6">
      <WorkspaceHero
        icon={CarFront}
        eyebrow="Showroom operations"
        title="Test drives"
        description="Control the customer drive from vehicle assignment and handover through return, outcome and conversion."
        stats={[
          { label: "Bookings · 30 days", value: metrics.bookings, detail: `${metrics.bookingRate}% of eligible leads`, icon: CalendarDays, tone: "primary" },
          { label: "Attendance", value: `${metrics.attendanceRate}%`, detail: `${metrics.attended} attended · ${metrics.noShows} no-shows`, icon: UserCheck, tone: "success" },
          { label: "Quote conversion", value: `${metrics.quoteConversionRate}%`, detail: `${metrics.saleConversionRate}% became sales`, icon: Route },
          { label: "Incidents", value: metrics.incidents, detail: `${metrics.incidentRate}% incident rate`, icon: TriangleAlert, tone: metrics.incidents > 0 ? "danger" : "default" },
        ]}
        actions={<>
        <Link href="/test-drives/demo-fleet" className={buttonVariants({ variant: "secondary", size: "sm" })}>
          <CarFront className="size-4" /> Demo fleet
        </Link>
        {canCreate && (
          <TestDriveBookingTrigger
            contacts={contacts}
            leads={leads}
            demos={demos}
            products={products}
            staff={staff}
            salespersonId={user.id}
            defaultStart={inputDate(defaultStart)}
            defaultEnd={inputDate(defaultEnd)}
          />
        )}
        </>}
      />

      <Surface className="overflow-visible">
        <div className="flex flex-col gap-4 border-b border-border p-4 xl:flex-row xl:items-end xl:justify-between xl:p-5">
          <SectionHeading title="Booking ledger" description={`${bookings.length} booking${bookings.length === 1 ? "" : "s"} in this view · ${metrics.bookedHours} fleet hours reserved`} />
          <nav className="flex max-w-full gap-1 overflow-x-auto rounded-xl border border-border bg-background/40 p-1" aria-label="Test drive status">
          {TEST_DRIVE_FILTERS.map((value) => (
            <Link
              key={value || "all"}
              href={value ? `/test-drives?status=${value}` : "/test-drives"}
              className={`shrink-0 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${status === value || (!status && !value) ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
            >
              {value ? testDriveStatusLabel(value) : "All"}
            </Link>
          ))}
          </nav>
        </div>

        <div className="grid gap-px bg-border xl:grid-cols-[minmax(0,1fr)_17rem]">
          <div className="min-w-0 bg-card">

      {bookings.length === 0 ? (
        <EmptyState icon={CalendarDays} title="No test drives in this view" description="Book a customer drive or choose another status filter." className="m-4 border-0 bg-transparent" />
      ) : (
        <ResponsiveEntityTable>
          <table className="table-base">
            <thead><tr><th>Booking</th><th>Customer</th><th>Vehicle</th><th>Schedule</th><th>Salesperson</th><th>Status</th></tr></thead>
            <tbody>
              {bookings.map((booking) => (
                <tr key={booking.id}>
                  <td data-primary data-label="Booking">
                    <Link href={`/test-drives/${booking.id}`} className="font-medium text-primary hover:underline">{booking.reference}</Link>
                    {booking.leadId && <p className="max-w-56 truncate text-xs text-muted-foreground">{leadMap.get(booking.leadId) ?? "Linked lead"}</p>}
                  </td>
                  <td data-label="Customer">{contactMap.get(booking.contactId) ?? "Customer"}</td>
                  <td data-label="Vehicle">
                    <p>{booking.demoVehicle?.name ?? (booking.productId ? productMap.get(booking.productId) : null) ?? "Not assigned"}</p>
                    <p className="text-xs text-muted-foreground">{booking.branch}</p>
                  </td>
                  <td data-label="Schedule">
                    <p>{formatDateTime(booking.scheduledStart)}</p>
                    <p className="text-xs text-muted-foreground">Return {format(booking.expectedReturnAt, "HH:mm")}</p>
                  </td>
                  <td data-label="Salesperson">{staffMap.get(booking.salespersonId) ?? "Unavailable user"}</td>
                  <td data-label="Status"><StatusPill tone={statusTone[booking.status] ?? "neutral"}>{testDriveStatusLabel(booking.status)}</StatusPill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </ResponsiveEntityTable>
      )}
          </div>
          <aside className="space-y-5 bg-background/35 p-5">
            <div>
              <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground"><Gauge className="size-3.5" />Fleet readiness</p>
              <p className="mt-2 text-3xl font-semibold tracking-tight text-foreground">{metrics.utilisationRate}%</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">Demo utilisation across {activeDemoVehicleCount} active vehicle{activeDemoVehicleCount === 1 ? "" : "s"}.</p>
            </div>
            <div className="grid grid-cols-2 gap-2 xl:grid-cols-1">
              <div className="rounded-xl border border-border bg-card/70 p-3"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">New leads booked</p><p className="mt-1 text-lg font-semibold tabular-nums">{metrics.bookedLeads}</p></div>
              <div className="rounded-xl border border-border bg-card/70 p-3"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">Booked hours</p><p className="mt-1 text-lg font-semibold tabular-nums">{metrics.bookedHours}</p></div>
            </div>
            <Link href="/test-drives/demo-fleet" className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"><CarFront className="size-3.5" />Manage demo fleet</Link>
          </aside>
        </div>
      </Surface>
      </DesktopOnly>
    </>
  );
}
