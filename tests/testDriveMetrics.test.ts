import assert from "node:assert/strict";
import test from "node:test";
import { calculateTestDriveMetrics } from "../src/lib/testDriveMetrics";

const at = (hour: number) => new Date(`2026-07-01T${String(hour).padStart(2, "0")}:00:00Z`);

const base = {
  scheduledStart: at(9),
  expectedReturnAt: at(10),
  actualStartAt: null,
  actualReturnAt: null,
  convertedQuoteId: null,
  salesOutcome: null,
  newDamage: null,
  incidentReport: null,
};

test("calculates attendance, no-show and conversion rates", () => {
  const result = calculateTestDriveMetrics({
    eligibleLeadCount: 10,
    activeDemoVehicleCount: 2,
    periodDays: 1,
    bookings: [
      { ...base, status: "completed", actualStartAt: at(9), actualReturnAt: at(10), convertedQuoteId: "quote-1", salesOutcome: "sale_won" },
      { ...base, status: "completed", actualStartAt: at(9), actualReturnAt: at(10), salesOutcome: "follow_up" },
      { ...base, status: "no_show" },
      { ...base, status: "cancelled" },
    ],
  });

  assert.equal(result.bookings, 3);
  assert.equal(result.bookingRate, 30);
  assert.equal(result.attended, 2);
  assert.equal(result.attendanceRate, 67);
  assert.equal(result.noShows, 1);
  assert.equal(result.noShowRate, 33);
  assert.equal(result.quoteConversions, 1);
  assert.equal(result.quoteConversionRate, 33);
  assert.equal(result.saleConversions, 1);
  assert.equal(result.saleConversionRate, 33);
});

test("calculates utilisation from scheduled hours and active demo vehicles", () => {
  const result = calculateTestDriveMetrics({
    eligibleLeadCount: 0,
    activeDemoVehicleCount: 1,
    periodDays: 1,
    operatingHoursPerDay: 8,
    bookings: [
      { ...base, status: "booked", scheduledStart: at(9), expectedReturnAt: at(11) },
      { ...base, status: "confirmed", scheduledStart: at(12), expectedReturnAt: at(14) },
    ],
  });

  assert.equal(result.bookedHours, 4);
  assert.equal(result.utilisationRate, 50);
  assert.equal(result.bookingRate, 0);
});

test("counts damage and incident records against attended drives", () => {
  const result = calculateTestDriveMetrics({
    eligibleLeadCount: 2,
    activeDemoVehicleCount: 1,
    periodDays: 1,
    bookings: [
      { ...base, status: "completed", actualStartAt: at(9), newDamage: "Scratch on left rear" },
      { ...base, status: "completed", actualStartAt: at(9) },
    ],
  });

  assert.equal(result.incidents, 1);
  assert.equal(result.incidentRate, 50);
});
