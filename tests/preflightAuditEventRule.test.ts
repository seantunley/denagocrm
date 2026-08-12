import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE PREFLIGHT AND THE AUDIT WRITER MUST AGREE ABOUT WHICH NULLS ARE LEGITIMATE.
 *
 * They did not, and the disagreement was load-bearing. `check-production.ts`
 * section 5 treats a NULL tenant on any tenant-scoped model as a hard failure;
 * `audit.ts` deliberately leaves `actingTenantId` nullable for platform-admin and
 * system work, because those events genuinely have no owning workspace. Merge
 * both positions and, after correctly backfilling the 13 attributable rows,
 * production still holds 11 legitimate ones and the gate reads FAIL forever —
 * and any future platform action turns a green preflight red again.
 *
 * The wrong repair is to stamp those 11 with the founding tenant to quiet the
 * checker. That converts genuinely global events into one workspace's events,
 * which is the invented attribution `audit.ts` argues against at length.
 *
 * So the rule is explicit and narrow, and pinned here in both directions: an
 * attributable actor with no workspace FAILS, a platform/system actor with no
 * workspace is REPORTED. Drift in either direction breaks a test.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL("../scripts/check-production.ts", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

/** Strip comments so prose can never satisfy an assertion. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the global-actor list is exactly platform_admin and system_global", () => {
  const decl = /GLOBAL_AUDIT_ACTOR_TYPES\s*=\s*\[([^\]]*)\]/.exec(CODE);
  assert.ok(decl, "GLOBAL_AUDIT_ACTOR_TYPES must exist — it is the whole rule");
  const listed = [...decl[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(
    listed,
    ["platform_admin", "system_global"],
    "widening this list silently converts real lost-attribution failures into warnings",
  );
  // THE ONE THAT MATTERS. Bare `system` is the CATCH-ALL arm of actorType — no
  // entry.user and an actor name matching none of the patterns — so it is not
  // evidence of a global scope. Two of production's five tenantless `system`
  // events carry real person names ("Sean Tunley", "Gavin Tagg" on
  // signing.signed): people signing inside one workspace. remindVehicleService
  // is the same shape. Exempting `system` would wave through precisely the
  // regression this check exists to catch — a tenant-specific write that LOST
  // its scope — while looking careful about it.
  assert.ok(
    !listed.includes("system"),
    "bare `system` is a fallback, not a scope claim: exempting it hides lost-scope writes",
  );
  assert.ok(
    !listed.includes("customer") && !listed.includes("automation"),
    "a portal request and a cron slice both run inside a bound tenant scope, so a NULL there is a real gap",
  );
});

test("attributable tenantless audit rows FAIL, they are not warned about", () => {
  const branch = /if \(table === "AuditEvent"\) \{([\s\S]*?)\n      continue;/.exec(CODE);
  assert.ok(branch, "section 5 must special-case AuditEvent rather than applying the blanket rule");
  assert.match(
    branch[1],
    /if \(split\.attributable > 0\) \{[\s\S]*?failures\.push/,
    "a signed-in person's event losing its workspace is a real defect and must block",
  );
  assert.match(
    branch[1],
    /if \(split\.global > 0\) \{[\s\S]*?warnings\.push/,
    "platform/system events have no owning workspace and must be reported, not block",
  );
  assert.doesNotMatch(
    branch[1],
    /split\.global[\s\S]{0,120}failures\.push/,
    "a legitimately global audit event must never become a blocker",
  );
});

test("the split classifies by actorType, and unknown actor types fail closed", () => {
  const fn = CODE.slice(CODE.indexOf("async function auditEventNullSplit"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 1);
  assert.match(body, /GROUP BY "actorType"/, "the split must be driven by the actor, not by the entity");
  // The `else` arm is the fail-closed one: anything not explicitly listed as
  // global — including a NULL actorType — counts as attributable and blocks.
  assert.match(
    body,
    /includes\(type\)\s*\)\s*\{[\s\S]*?global \+= n;[\s\S]*?\}\s*else\s*\{[\s\S]*?attributable \+= n;/,
    "an unrecognised actor type must be treated as attributable, never waved through as global",
  );
  assert.match(
    body,
    /row\.actorType \?\? "\(none\)"/,
    "a NULL actorType must fall into the attributable branch rather than matching a global name",
  );
});

test("the AuditEvent rule does not weaken the blanket rule for every other table", () => {
  // The special case must be exactly one table wide. If AuditEvent's `continue`
  // were hoisted or the condition broadened, every other model's NULL rows would
  // stop failing — which is the check the cutover actually depends on.
  assert.match(
    CODE,
    /\}\s*if \(sharedNullable\) \{[\s\S]*?warnings\.push[\s\S]*?\} else \{[\s\S]*?failures\.push/,
    "the shared-nullable/failure branches must still apply to every non-AuditEvent table",
  );
  const auditGuards = [...CODE.matchAll(/table === "AuditEvent"/g)];
  assert.equal(auditGuards.length, 1, "exactly one table may be special-cased here");
});
