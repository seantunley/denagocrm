import assert from "node:assert/strict";
import test from "node:test";
import { calculateTestDriveMetrics } from "../src/lib/testDriveMetrics";

const at = (hour: number) => new Date(`2026-07-01T${String(hour).padStart(2, "0")}:00:00Z`);

const base = {
  leadId: null,
  scheduledStart: at(9),
  expectedReturnAt: at(10),
  actualStartAt: null,
  actualReturnAt: null,
  convertedQuoteId: null,
  salesOutcome: null,
  newDamage: null,
  incidentReport: null,
};

test("calculates period-matched booking, attendance, no-show and attended conversion rates", () => {
  const result = calculateTestDriveMetrics({
    eligibleLeadIds: ["lead-1", "lead-2", "lead-3", "lead-5", "lead-6", "lead-7", "lead-8", "lead-9", "lead-10", "lead-11"],
    activeDemoVehicleCount: 2,
    periodDays: 1,
    bookings: [
      { ...base, leadId: "lead-1", status: "completed", actualStartAt: at(9), actualReturnAt: at(10), convertedQuoteId: "quote-1", salesOutcome: "sale_won" },
      { ...base, leadId: "lead-2", status: "completed", actualStartAt: at(9), actualReturnAt: at(10), salesOutcome: "follow_up" },
      { ...base, leadId: "lead-3", status: "no_show" },
      { ...base, leadId: "lead-4", status: "cancelled" },
    ],
  });

  assert.equal(result.bookings, 3);
  assert.equal(result.bookedLeads, 3);
  assert.equal(result.bookingRate, 30);
  assert.equal(result.attended, 2);
  assert.equal(result.attendanceRate, 67);
  assert.equal(result.noShows, 1);
  assert.equal(result.noShowRate, 33);
  assert.equal(result.quoteConversions, 1);
  assert.equal(result.quoteConversionRate, 50);
  assert.equal(result.saleConversions, 1);
  assert.equal(result.saleConversionRate, 50);
});

test("does not count repeated or out-of-period leads in booking rate", () => {
  const result = calculateTestDriveMetrics({
    eligibleLeadIds: ["lead-1", "lead-2", "lead-3", "lead-4"],
    activeDemoVehicleCount: 1,
    periodDays: 1,
    bookings: [
      { ...base, leadId: "lead-1", status: "completed", actualStartAt: at(9) },
      { ...base, leadId: "lead-1", status: "completed", actualStartAt: at(9) },
      { ...base, leadId: "older-lead", status: "completed", actualStartAt: at(9) },
    ],
  });

  assert.equal(result.bookings, 3);
  assert.equal(result.bookedLeads, 1);
  assert.equal(result.bookingRate, 25);
});

test("calculates utilisation from scheduled hours and active demo vehicles", () => {
  const result = calculateTestDriveMetrics({
    eligibleLeadIds: [],
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
    eligibleLeadIds: ["lead-1", "lead-2"],
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
