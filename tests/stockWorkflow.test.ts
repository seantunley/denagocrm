import test from "node:test";
import assert from "node:assert/strict";
import {
  allocateLandedCost,
  allowedStockTransitions,
  canTransitionStock,
  normalizeSerial,
  normalizeStockNumber,
  reorderRecommendation,
  reservationUrgency,
  stockAgeBand,
  stockAgeDays,
} from "../src/lib/stockWorkflow";

test("stock transitions enforce the controlled lifecycle", () => {
  assert.equal(canTransitionStock("available", "reserved"), true);
  assert.equal(canTransitionStock("reserved", "allocated"), true);
  assert.equal(canTransitionStock("allocated", "pdi"), true);
  assert.equal(canTransitionStock("pdi", "ready"), true);
  assert.equal(canTransitionStock("ready", "delivered"), true);
  assert.equal(canTransitionStock("incoming", "reserved"), false);
  assert.equal(canTransitionStock("available", "delivered"), false);
  assert.deepEqual(allowedStockTransitions("delivered"), []);
});

test("stock identifiers are normalised consistently", () => {
  assert.equal(normalizeSerial("  ab 12 cd  "), "AB12CD");
  assert.equal(normalizeSerial(""), null);
  assert.equal(normalizeStockNumber(" stk 10/22 "), "STK1022");
});

test("stock ageing uses stable day bands", () => {
  const now = new Date("2026-07-17T10:00:00.000Z");
  assert.equal(stockAgeDays(new Date("2026-07-16T10:00:00.000Z"), now), 1);
  assert.equal(stockAgeDays(null, now), null);
  assert.equal(stockAgeBand(12), "fresh");
  assert.equal(stockAgeBand(45), "watch");
  assert.equal(stockAgeBand(75), "aged");
  assert.equal(stockAgeBand(120), "critical");
});

test("reservation urgency highlights expiry windows", () => {
  const now = new Date("2026-07-17T10:00:00.000Z");
  assert.equal(reservationUrgency(new Date("2026-07-17T09:00:00.000Z"), now), "expired");
  assert.equal(reservationUrgency(new Date("2026-07-18T09:00:00.000Z"), now), "today");
  assert.equal(reservationUrgency(new Date("2026-07-20T09:00:00.000Z"), now), "soon");
  assert.equal(reservationUrgency(new Date("2026-07-25T09:00:00.000Z"), now), "healthy");
});

test("reorder recommendation accounts for demand, commitments and safety stock", () => {
  assert.equal(reorderRecommendation({ openDemand: 5, available: 2, incoming: 1, reserved: 1 }), 4);
  assert.equal(reorderRecommendation({ openDemand: 2, available: 4, incoming: 1, reserved: 1 }), 0);
  assert.equal(reorderRecommendation({ openDemand: 0, available: 0, incoming: 0, reserved: 0, safetyStock: 2 }), 2);
});

test("landed overhead is allocated across received units", () => {
  const allocated = allocateLandedCost([
    { key: "a", qty: 2, unitCostCents: 100_000 },
    { key: "b", qty: 1, unitCostCents: 200_000 },
  ], 40_000);
  assert.equal(allocated.a, 110_000);
  assert.equal(allocated.b, 220_000);
  const total = allocated.a * 2 + allocated.b;
  assert.equal(total, 440_000);
});
