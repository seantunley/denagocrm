export type TestDriveMetricRow = {
  leadId: string | null;
  status: string;
  scheduledStart: Date;
  expectedReturnAt: Date;
  actualStartAt: Date | null;
  actualReturnAt: Date | null;
  convertedQuoteId: string | null;
  salesOutcome: string | null;
  newDamage: string | null;
  incidentReport: string | null;
};

export type TestDriveMetrics = {
  bookings: number;
  bookedLeads: number;
  bookingRate: number;
  attended: number;
  attendanceRate: number;
  noShows: number;
  noShowRate: number;
  quoteConversions: number;
  quoteConversionRate: number;
  saleConversions: number;
  saleConversionRate: number;
  bookedHours: number;
  utilisationRate: number;
  incidents: number;
  incidentRate: number;
};

const percent = (numerator: number, denominator: number) =>
  denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;

const hoursBetween = (start: Date, end: Date) =>
  Math.max(0, end.getTime() - start.getTime()) / 3_600_000;

export function calculateTestDriveMetrics(args: {
  bookings: TestDriveMetricRow[];
  eligibleLeadIds: readonly string[];
  activeDemoVehicleCount: number;
  periodDays: number;
  operatingHoursPerDay?: number;
}): TestDriveMetrics {
  const operatingHoursPerDay = args.operatingHoursPerDay ?? 8;
  const bookings = args.bookings.filter((booking) => booking.status !== "cancelled");
  const eligibleLeadIds = new Set(args.eligibleLeadIds);
  const bookedLeads = new Set(
    bookings
      .map((booking) => booking.leadId)
      .filter((leadId): leadId is string => Boolean(leadId) && eligibleLeadIds.has(leadId)),
  ).size;
  const attendedRows = bookings.filter((booking) =>
    booking.actualStartAt !== null || booking.status === "checked_out" || booking.status === "completed"
  );
  const noShows = bookings.filter((booking) => booking.status === "no_show").length;
  const quoteConversions = attendedRows.filter((booking) =>
    Boolean(booking.convertedQuoteId) || booking.salesOutcome === "quote_created" || booking.salesOutcome === "sale_won"
  ).length;
  const saleConversions = attendedRows.filter((booking) => booking.salesOutcome === "sale_won").length;
  const incidents = attendedRows.filter((booking) =>
    Boolean(booking.newDamage?.trim()) || Boolean(booking.incidentReport?.trim())
  ).length;
  const bookedHours = bookings.reduce(
    (sum, booking) => sum + hoursBetween(booking.scheduledStart, booking.expectedReturnAt),
    0,
  );
  const availableHours = Math.max(0, args.activeDemoVehicleCount) * Math.max(1, args.periodDays) * operatingHoursPerDay;

  return {
    bookings: bookings.length,
    bookedLeads,
    bookingRate: percent(bookedLeads, eligibleLeadIds.size),
    attended: attendedRows.length,
    attendanceRate: percent(attendedRows.length, bookings.length),
    noShows,
    noShowRate: percent(noShows, bookings.length),
    quoteConversions,
    quoteConversionRate: percent(quoteConversions, attendedRows.length),
    saleConversions,
    saleConversionRate: percent(saleConversions, attendedRows.length),
    bookedHours: Math.round(bookedHours * 10) / 10,
    utilisationRate: percent(bookedHours, availableHours),
    incidents,
    incidentRate: percent(incidents, attendedRows.length),
  };
}

export const TEST_DRIVE_STATUS = {
  booked: { label: "Booked", tone: "info" },
  confirmed: { label: "Confirmed", tone: "success" },
  checked_out: { label: "Out on drive", tone: "warning" },
  completed: { label: "Completed", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  no_show: { label: "No-show", tone: "danger" },
} as const;

export function testDriveStatusLabel(status: string): string {
  return TEST_DRIVE_STATUS[status as keyof typeof TEST_DRIVE_STATUS]?.label ?? status.replaceAll("_", " ");
}
