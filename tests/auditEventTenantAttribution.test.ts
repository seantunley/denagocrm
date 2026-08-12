import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

/**
 * `AuditEvent` MUST NOT inherit `AuditLog`'s NULL-tenant concession.
 *
 * The two tables are written together by `writeAudit`, and they are constrained
 * differently: `AuditLog` carries the composite keys `(tenantId, contactId)` and
 * `(tenantId, leadId)`, so when the referenced lead and contact disagree the row
 * has to degrade to a NULL tenant or the insert fails — that is the 2026-08-07
 * duplicate-lead incident `bestEffortAgreedTenantId` exists to prevent.
 * `AuditEvent` carries NO foreign key at all, so nothing about it requires the
 * concession.
 *
 * One shared value meant the concession was charged to both, and under FORCE RLS
 * `AuditEvent`'s policy has no NULL escape hatch — so a null-tenant event is
 * invisible to every workspace, including the one whose action produced it.
 * Production is carrying 24 such rows, and they are the events where the
 * references disagreed: the unusual ones, which is the set an investigation
 * looks for first.
 */

const SOURCE = readFileSync(new URL("../src/lib/audit.ts", import.meta.url), "utf8");

/** Strip block and line comments so prose can never satisfy an assertion. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const CODE = code(SOURCE);

test("the AuditEvent INSERT binds the undegraded `event` tenant", () => {
  const insert = /INSERT INTO "AuditEvent"[\s\S]*?VALUES\s*\(([\s\S]*?)\)\s*`/.exec(CODE);
  assert.ok(insert, "could not locate the AuditEvent INSERT — this test must be re-pointed, not deleted");
  assert.match(
    insert[1],
    /\$\{tenantIds\.event\}/,
    "AuditEvent must bind tenantIds.event; binding the shared/degraded value makes the row invisible under RLS",
  );
  assert.doesNotMatch(
    insert[1],
    /\$\{tenantIds\.log\}/,
    "AuditEvent must not bind the AuditLog concession value",
  );
});

test("the AuditLog create keeps the composite-key-safe `log` tenant", () => {
  // The concession is still REQUIRED here. A well-meaning "fix" that gave
  // AuditLog the acting tenant would reintroduce the FK failure that left two
  // duplicate leads behind in production.
  assert.match(
    CODE,
    /auditLog\.create\(\{[\s\S]*?tenantId:\s*tenantIds\.log/,
    "AuditLog must keep the best-effort value its composite FK requires",
  );
});

test("the logAudit fallback also writes an AuditLog, so it too takes `log`", () => {
  const fallback = CODE.slice(CODE.indexOf("export async function logAudit"));
  assert.match(
    fallback,
    /tenantId:\s*\(await auditTenantIds\(entry\)\)\.log/,
    "the retry writes an AuditLog row and must use the constrained value",
  );
});

test("no caller resolves a single shared audit tenant any more", () => {
  assert.doesNotMatch(
    CODE,
    /\bauditTenantId\s*\(/,
    "the single-value resolver is what conflated the two tables; it must not come back",
  );
});

test("the resolver returns the acting tenant for `event` even when references disagree", () => {
  // The behavioural core, asserted on the return expression itself: `log` may be
  // degraded by bestEffortAgreedTenantId, `event` may never be.
  assert.match(
    CODE,
    /return\s*\{\s*event:\s*acting,\s*log:\s*bestEffortAgreedTenantId\(referenced,\s*acting\)\s*\}/,
    "the disagreement branch must degrade only `log`",
  );
  assert.match(
    CODE,
    /return\s*\{\s*event:\s*acting,\s*log:\s*acting\s*\}/,
    "the no-references branch must return the acting tenant for both",
  );
});
