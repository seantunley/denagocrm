import assert from "node:assert/strict";
import test from "node:test";
import { captureTargetFromPath, nextStepDue, waMeLink } from "../src/lib/captureTarget";

test("the sheet opens on the lead or customer whose page it was opened from", () => {
  assert.deepEqual(captureTargetFromPath("/leads/clx123"), { type: "lead", id: "clx123" });
  assert.deepEqual(captureTargetFromPath("/leads/clx123/indemnity"), { type: "lead", id: "clx123" });
  assert.deepEqual(captureTargetFromPath("/contacts/abc"), { type: "contact", id: "abc" });
  assert.deepEqual(captureTargetFromPath("/contacts/abc/edit/"), { type: "contact", id: "abc" });
});

test("anywhere else — a list, a different section, a page under /leads that is not a record — it asks", () => {
  for (const path of ["/", "/leads", "/leads/", "/leads/new", "/leads/nurture", "/leads/attention", "/leads/closed", "/leads/list", "/contacts", "/contacts/new", "/deals/abc", "/jobcards/abc", "/inbox"]) {
    assert.equal(captureTargetFromPath(path), null, path);
  }
});

test("a next-step chip is that many calendar days on, at 09:00 — never a time in the small hours", () => {
  const lateFriday = new Date(2026, 10, 6, 23, 45); // 6 Nov 2026, local
  assert.equal(nextStepDue("tomorrow", lateFriday), "2026-11-07T09:00");
  assert.equal(nextStepDue("2days", lateFriday), "2026-11-08T09:00");
  assert.equal(nextStepDue("1week", lateFriday), "2026-11-13T09:00");
  // Month and year roll over through the Date constructor, not by hand.
  assert.equal(nextStepDue("1week", new Date(2026, 11, 28, 8, 0)), "2027-01-04T09:00");
});

test("wa.me takes digits only, with a local 0 made South Africa's 27 — the same link WhatsAppPanel builds", () => {
  assert.equal(waMeLink("082 123 4567"), "https://wa.me/27821234567");
  assert.equal(waMeLink("+27 82 123 4567"), "https://wa.me/27821234567");
  assert.equal(waMeLink(""), null);
  assert.equal(waMeLink(null), null);
});
