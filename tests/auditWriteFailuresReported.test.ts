import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// Gap audit #35: logAudit swallowed both failures — the tamper-evident event,
// then the legacy fallback row — in empty catches, so a broken audit trail
// looked exactly like a quiet one.

const audit = readFileSync(new URL("../src/lib/audit.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const fn = audit.slice(audit.indexOf("export async function logAudit("), audit.indexOf("export async function logAuditStrict("));

test("no empty catch is left in logAudit", () => {
  assert.doesNotMatch(fn, /catch \{\}/);
  assert.doesNotMatch(fn, /\} catch \{\n/);
});

test("both failures are reported, the lost entry loudest", () => {
  assert.match(fn, /catch \(err\) \{\s*(\/\/[^\n]*\n\s*)*await reportAuditFailure\(entry, err, "audit event not written;/);
  assert.match(fn, /catch \(fallbackErr\) \{\s*await reportAuditFailure\(entry, fallbackErr, "audit entry LOST/);
});

test("the report carries the action and record ids — never the summary (it names customers)", () => {
  const report = audit.slice(audit.indexOf("async function reportAuditFailure("), audit.indexOf("export async function logAudit("));
  assert.match(report, /logError\(\s*"audit-write",/);
  assert.match(report, /action \$\{entry\.action\}/);
  assert.doesNotMatch(report, /entry\.summary/);
  assert.doesNotMatch(report, /entry\.userName|entry\.user\?\.name/);
});
