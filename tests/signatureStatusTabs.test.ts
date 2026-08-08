import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync("src/app/(app)/signatures/page.tsx", "utf8");

test("signature request tabs keep the requested order and URL-backed state", () => {
  const completed = page.indexOf('{ value: "completed", label: "Completed" }');
  const voided = page.indexOf('{ value: "voided", label: "Voided" }');
  const inProgress = page.indexOf('{ value: "in-progress", label: "In Progress" }');

  assert.ok(completed >= 0, "Completed tab should exist");
  assert.ok(voided > completed, "Voided should follow Completed");
  assert.ok(inProgress > voided, "In Progress should follow Voided");
  assert.ok(page.includes('href={`/signatures?status=${view.value}`}'), "each tab should update the URL");
  assert.match(page, /aria-current={active \? "page" : undefined}/);
});

test("signature request tabs partition every lifecycle state", () => {
  assert.match(page, /if \(status === "completed"\) return "completed"/);
  assert.match(page, /if \(isRequestClosed\(status\)\) return "voided"/);
  assert.match(page, /return "in-progress"/);
  assert.match(page, /: "in-progress";/, "In Progress should be the default view");
  assert.match(page, /visibleRequests\.map/, "only requests from the active tab should render");
});
