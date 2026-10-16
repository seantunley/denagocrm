import assert from "node:assert/strict";
import test from "node:test";
import { customerHistoryDay, matchesCustomerHistoryFilter } from "../src/lib/customerHistoryFilters";

test("history day headings use South African midnight, including a UTC date boundary", () => {
  assert.equal(customerHistoryDay(new Date("2026-10-15T21:59:00Z")), "15 October 2026");
  assert.equal(customerHistoryDay(new Date("2026-10-15T22:00:00Z")), "16 October 2026");
  assert.equal(customerHistoryDay(new Date("2026-10-16T02:00:00Z")), "16 October 2026");
});

test("All keeps social and legacy channels that have no dedicated filter", () => {
  for (const channel of ["messenger", "instagram", "meeting", "legacy-channel"]) {
    assert.equal(matchesCustomerHistoryFilter(channel, "all"), true);
    assert.equal(matchesCustomerHistoryFilter(channel, "email"), false);
  }
});

test("channel filters do not mix internal notes, activities or audit changes with messages", () => {
  const types = ["note", "activity", "audit", "email", "whatsapp", "call"];
  for (const filter of ["note", "activity", "audit", "email", "whatsapp", "call"] as const) {
    assert.deepEqual(types.filter((type) => matchesCustomerHistoryFilter(type, filter)), [filter]);
  }
});
