import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CLOSED_REQUEST_STATUSES,
  signatureRequestView,
} from "../src/lib/signing/statusPolicy";

const page = readFileSync("src/app/(app)/signatures/page.tsx", "utf8");

test("signature request tabs keep the requested order and URL-backed state", () => {
  const inProgress = page.indexOf('{ value: "in-progress", label: "In Progress" }');
  const completed = page.indexOf('{ value: "completed", label: "Completed" }');
  const voided = page.indexOf('{ value: "voided", label: "Voided" }');
  const declined = page.indexOf('{ value: "declined", label: "Declined" }');
  const rejected = page.indexOf('{ value: "rejected", label: "Rejected" }');
  const expired = page.indexOf('{ value: "expired", label: "Expired" }');

  assert.ok(inProgress >= 0, "In Progress should be the first tab");
  assert.ok(completed > inProgress, "Completed should follow In Progress");
  assert.ok(voided > completed, "Voided should follow Completed");
  assert.ok(declined > voided, "Declined should follow Voided");
  assert.ok(rejected > declined, "Rejected should follow Declined");
  assert.ok(expired > rejected, "Expired should follow Rejected");
  assert.match(page, /href={signaturesHref\(view\.value\)}/, "each tab should update the URL");
  assert.match(page, /aria-current={active \? "page" : undefined}/);
});

test("signature request tabs execute the complete lifecycle contract", () => {
  const expected = {
    draft: "in-progress",
    sent: "in-progress",
    viewed: "in-progress",
    in_progress: "in-progress",
    completed: "completed",
    declined: "declined",
    voided: "voided",
    expired: "expired",
    rejected: "rejected",
  } as const;

  for (const [status, view] of Object.entries(expected)) {
    assert.equal(signatureRequestView(status), view, `${status} should map to ${view}`);
  }
  assert.deepEqual(
    [...CLOSED_REQUEST_STATUSES],
    ["completed", "declined", "voided", "expired", "rejected"],
    "the view contract should exercise every centrally defined closed status",
  );
});

test("counts and rows come from independent database queries", () => {
  assert.match(page, /prisma\.signatureRequest\.groupBy\(/, "tab counts should cover the full dataset");
  assert.match(page, /skip: \(currentPage - 1\) \* PAGE_SIZE/);
  assert.match(page, /take: PAGE_SIZE/);
  assert.doesNotMatch(page, /requestsByView|requests\.filter\(/, "a truncated row query must not drive global counts");
});

test("pending approvals use the central closed lifecycle policy", () => {
  assert.match(page, /status: \{ notIn: \[\.\.\.CLOSED_REQUEST_STATUSES\] \}/);
});
