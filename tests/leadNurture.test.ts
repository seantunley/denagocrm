import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNurtureForm, reviewDate } from "../src/lib/leadNurture";

const now = new Date("2026-10-18T10:00:00Z");
function form(overrides: Record<string, string> = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries({ reason: "product", interest: "  4×4   hunting vehicle ", trigger: "Call when specifications arrive", reviewDate: "2026-11-18", assignedToId: "salesperson", ...overrides })) data.set(key, value);
  return data;
}
test("nurture captures a future product without a catalogue ID", () => {
  const result = parseNurtureForm(form(), now);
  assert.ok(!("error" in result));
  assert.equal(result.interest, "4×4 hunting vehicle");
  assert.equal(result.reviewAt.toISOString(), "2026-11-18T07:00:00.000Z");
});
test("missing reason, trigger, owner, interest and invalid dates are refused", () => {
  const cases: Record<string, string>[] = [{ reason: "__proto__" }, { trigger: " " }, { interest: " " }, { assignedToId: "" }, { reviewDate: "2026-10-17" }, { reviewDate: "2027-02-30" }, { interest: "a".repeat(121) }];
  for (const overrides of cases) {
    assert.ok("error" in parseNurtureForm(form(overrides), now), JSON.stringify(overrides));
  }
});
test("date boundaries use the South African business date", () => {
  assert.ok(reviewDate("2026-10-18", now));
  assert.equal(reviewDate("2026-10-18", new Date("2026-10-18T22:30:00Z")), null);
  assert.ok(reviewDate("2026-10-19", new Date("2026-10-18T22:30:00Z")));
});
