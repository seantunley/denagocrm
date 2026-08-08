import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CLOSED_REQUEST_STATUSES,
  signatureRequestView,
} from "../src/lib/signing/statusPolicy";

const page = readFileSync("src/app/(app)/signatures/page.tsx", "utf8");

test("signature request tabs keep the requested order and URL-backed state", () => {
  const completed = page.indexOf('{ value: "completed", label: "Completed" }');
  const voided = page.indexOf('{ value: "voided", label: "Voided" }');
  const inProgress = page.indexOf('{ value: "in-progress", label: "In Progress" }');

  assert.ok(completed >= 0, "Completed tab should exist");
  assert.ok(voided > completed, "Voided should follow Completed");
  assert.ok(inProgress > voided, "In Progress should follow Voided");
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
    declined: "voided",
    voided: "voided",
    expired: "voided",
    rejected: "voided",
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
