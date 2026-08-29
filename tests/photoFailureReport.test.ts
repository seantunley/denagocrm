import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  recordPhotoUploadFailure,
  sanitiseReason,
  type PhotoFailureDeps,
  type PhotoFailureTarget,
} from "../src/lib/photoFailureReport";

const src = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const TARGET: PhotoFailureTarget = { kind: "delivery", recordId: "q_1" };
const DETAIL = { stage: "finalize" as const, reason: "Failed to fetch" };

type Logged = { message: string; context: string; tenantId: string | null };

function deps(over: Partial<PhotoFailureDeps> = {}) {
  const rows: Logged[] = [];
  const d: PhotoFailureDeps = {
    identify: async () => ({ id: "u_1" }),
    resolveTenant: async () => "tenant_a",
    authorise: async () => true,
    isWorkspaceFailure: (e) => e instanceof WorkspaceError,
    log: async (entry) => { rows.push(entry); },
    ...over,
  };
  return { d, rows };
}

/** Stands in for TenantScopeError: the ONE failure that means "could not check". */
class WorkspaceError extends Error {}
const noWorkspace = () => { throw new WorkspaceError("No workspace is attached to this sign-in"); };

/** How production actually denies: requireQuoteAccess calls redirect(), which THROWS. */
function redirectDenial(): never {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = "NEXT_REDIRECT;replace;/quotes;307;";
  throw error;
}

/**
 * THE HEADLINE CASE, RUN RATHER THAN READ.
 *
 * A Server Action does not inherit the page's tenant scope, so actingTenantId()
 * can throw — and requireQuoteAccess() re-enters the SAME tenant resolution
 * through actingRecordPredicate, so it throws for the same reason. The previous
 * fix made only the first best-effort, so the second still threw before the log
 * was reached and the System Log stayed empty in exactly the scenario the report
 * exists for. The earlier tests asserted source ORDER and could not have caught
 * that; these execute it.
 */
test("a row is still written when NEITHER the workspace NOR the record check can resolve", async () => {
  const { d, rows } = deps({
    resolveTenant: noWorkspace,
    authorise: noWorkspace,
  });

  const outcome = await recordPhotoUploadFailure(d, TARGET, DETAIL);

  assert.equal(outcome.logged, true, "this is the case the whole report exists for");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tenantId, null, "unattributed rather than not written");
  assert.match(rows[0].message, /Failed to fetch/, "and it carries the reason the browser saw");
});

test("the row says the workspace and the authorisation were unknown", async () => {
  // Someone reading this log must be able to tell "could not check" from
  // "checked and allowed". Collapsing them is how a log stops being evidence.
  const { d, rows } = deps({ resolveTenant: noWorkspace, authorise: noWorkspace });
  await recordPhotoUploadFailure(d, TARGET, DETAIL);

  assert.match(rows[0].context, /authorised=unknown/);
  assert.match(rows[0].context, /workspace=unresolved/);
  assert.match(rows[0].context, /source=browser/, "never mistakable for a server observation");
  assert.match(rows[0].context, /user=u_1/, "attributable to the person who hit it");
});

test("a completed check records that it passed, not that it was unknown", async () => {
  const { d, rows } = deps();
  await recordPhotoUploadFailure(d, TARGET, DETAIL);
  assert.match(rows[0].context, /authorised=yes/);
  assert.doesNotMatch(rows[0].context, /workspace=unresolved/);
  assert.equal(rows[0].tenantId, "tenant_a");
});

/* The protections that must NOT be relaxed to achieve any of the above. */

test("a REFUSAL still suppresses the row", async () => {
  // The caller has no business with this record, so their claim about it is not
  // evidence. This is the difference between "could not check" and "checked".
  const { d, rows } = deps({ authorise: async () => false });
  const outcome = await recordPhotoUploadFailure(d, TARGET, DETAIL);

  assert.equal(outcome.logged, false);
  assert.equal(outcome.authorised, false);
  assert.deepEqual(rows, [], "a refused caller must not be able to write rows");
});

test("no identity writes nothing at all", async () => {
  // Identity is the one hard requirement: it is what stops this being a way to
  // write arbitrary rows, and the only one obtainable without a workspace.
  const { d, rows } = deps({ identify: async () => null });
  const outcome = await recordPhotoUploadFailure(d, TARGET, DETAIL);

  assert.equal(outcome.logged, false);
  assert.deepEqual(rows, []);
});

test("authorisation is attempted even when the workspace is gone", async () => {
  // Best-effort must not mean skipped. A tenant failure must not become a way to
  // bypass the permission check entirely.
  let attempted = false;
  const { d } = deps({
    resolveTenant: noWorkspace,
    authorise: async () => { attempted = true; return true; },
  });
  await recordPhotoUploadFailure(d, TARGET, DETAIL);
  assert.equal(attempted, true, "the gate must still be called, and its refusal still honoured");
});

test("client text is reduced to one capped line before it reaches a log row", async () => {
  assert.equal(sanitiseReason("  a\n\nb  "), "a b");
  assert.equal(sanitiseReason(undefined), "");
  assert.equal(sanitiseReason("x".repeat(500)).length, 300);

  const { d, rows } = deps();
  await recordPhotoUploadFailure(d, TARGET, { stage: "transfer", reason: "line one\nline two" });
  assert.match(rows[0].message, /line one line two/, "a multi-line reason must not break the row");
});

test("no reason still produces a row that says so", async () => {
  const { d, rows } = deps();
  await recordPhotoUploadFailure(d, TARGET, { stage: "transfer" });
  assert.equal(rows.length, 1);
  assert.match(rows[0].message, /the browser reported no reason/);
});

/* Wiring: the action must actually use this, and in the right shape. */

test("the action delegates rather than re-implementing the order", () => {
  const code = src("src/app/actions/photoUploads.ts")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, "");

  assert.match(code, /recordPhotoUploadFailure\(/, "the decision logic lives in the testable module");
  assert.match(code, /identify: \(\) => getCurrentUser\(\)/, "identity must not require a workspace");
  assert.ok(
    !/const tenantId = await actingTenantId\(\);\s*\n\s*if \(target\.kind/.test(code),
    "resolving the tenant first is what made the log empty",
  );
  // The permission calls must sit inside authorise, unconditionally.
  assert.match(code, /await requireQuoteAccess\(t\.recordId, "deliveries\.manage"\);/);
  assert.match(code, /await requireJobCardAccess\(jobCardId, "jobcards\.manage"\);/);
});

/*
 * FAIL CLOSED ON DENIAL. requireQuoteAccess does not return false when access is
 * refused — it calls redirect(), which throws. Treating every throw as "could
 * not check" therefore let a signed-in person with no access to a record write
 * persistent log rows naming any record id, carrying any browser-supplied text.
 * The earlier refusal test only covered an explicit `false`, which production
 * authorisation never returns.
 */
test("a denial that THROWS suppresses the row, exactly like an explicit refusal", async () => {
  const { d, rows } = deps({ authorise: async () => redirectDenial() });
  const outcome = await recordPhotoUploadFailure(d, TARGET, DETAIL);

  assert.equal(outcome.authorised, false, "a thrown redirect is a refusal, not an unknown");
  assert.equal(outcome.logged, false);
  assert.deepEqual(rows, [], "a denied caller must not be able to write rows");
});

test("an unrecognised failure is a refusal, not a free pass", async () => {
  // Anything nobody thought about — a bug, a new error type, a database fault —
  // must close rather than open. Only the workspace failure is recognised, and it
  // is recognised POSITIVELY.
  for (const thrower of [
    () => { throw new Error("something else entirely"); },
    () => { throw "a bare string"; },
    () => { throw null; },
  ]) {
    const { d, rows } = deps({ authorise: async () => thrower() });
    const outcome = await recordPhotoUploadFailure(d, TARGET, DETAIL);
    assert.equal(outcome.logged, false, "an unrecognised throw must not write a row");
    assert.deepEqual(rows, []);
  }
});

test("only the workspace failure still reaches the log as unknown", async () => {
  // The whole point of the previous fix must survive this one.
  const { d, rows } = deps({ resolveTenant: noWorkspace, authorise: noWorkspace });
  const outcome = await recordPhotoUploadFailure(d, TARGET, DETAIL);

  assert.equal(outcome.logged, true);
  assert.equal(outcome.authorised, null);
  assert.match(rows[0].context, /authorised=unknown/);
});

test("the action recognises the workspace failure by type, not by message", () => {
  const code = src("src/app/actions/photoUploads.ts");
  assert.match(code, /isWorkspaceFailure: \(error\) => error instanceof TenantScopeError/,
    "matching on a message would break the moment the wording changed");
});
