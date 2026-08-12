import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  pipelineScopeFor,
  resolveStageParent,
  UNREACHABLE_STAGE_MESSAGE,
  type StageParentRow,
} from "../src/lib/pipelineTenantRule";
import { ActionRefusal, classifyFailure, type Failure } from "../src/lib/actionFailure";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";

/**
 * A CROSS-WORKSPACE EXISTENCE ORACLE ON STAGE IDS, AND WHY IT IS GONE.
 *
 * `moveStage` in src/app/actions/settings.ts took a stage id straight off a POST —
 * a bound server-action argument is forgeable — read the row on `basePrisma` (the
 * documented RLS bypass), and only THEN called `requireOwnedPipeline()`. The read's
 * value never reached the caller, and the comment sitting on it said exactly that
 * and stopped there.
 *
 * The value was never the leak. The BRANCH was:
 *
 *   a stage id owned by ANOTHER workspace  → resolves → reaches the gate → the gate
 *                                            throws Error("Pipeline not found") →
 *                                            asActionResult renders the generic
 *                                            sentence plus a reference code, and
 *                                            LOGS it.
 *   a stage id that exists NOWHERE         → `if (!stage) refuse(…)` one line
 *                                            earlier → rendered verbatim, no log.
 *
 * One bit, readable by anyone holding an id, answering "does this exist somewhere
 * in this deployment?" — which for a stage id is "is there another workspace, and
 * is this one of its stages?".
 *
 * WHAT THIS FILE PROVES:
 *
 *   1. the resolution rule returns the SAME value (null) for a foreign stage and a
 *      missing one — executed, over a two-workspace table, not pattern-matched;
 *   2. both of those, put through the REAL failure classifier, produce deep-equal
 *      outcomes: same kind, same message, no log line on either;
 *   3. the OLD two-step shape, driven through the same real classifier, produces
 *      two DIFFERENT outcomes — so the oracle is demonstrated rather than asserted,
 *      and this file would still have something to say if the fix were reverted;
 *   4. `moveStage` is actually wired to the bounded resolver, with no unscoped
 *      stage read left in front of the gate.
 *
 * `src/lib/pipelines.ts` and `src/app/actions/settings.ts` reach `server-only`,
 * which `node:test` cannot load, so (1)-(3) run against the rule in
 * `pipelineTenantRule.ts` — which is the module the production query is built from
 * — and (4) is checked against the action's source text, comments stripped.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const TENANT_A = DEFAULT_TENANT_ID; // the workspace doing the asking
const TENANT_B = "tenant_second_dealer";

/**
 * The stage → pipeline join, as two workspaces' rows in one table. This is the
 * shape `findOwnedPipelineForStage` selects: the stage supplies only its id and its
 * parent key, and every ownership fact comes off the PIPELINE.
 */
const TABLE: StageParentRow[] = [
  { stageId: "stage_a_new", pipelineId: "pipe_a", pipelineTenantId: TENANT_A, pipelineActive: true, pipelineDeleted: false },
  { stageId: "stage_a_won", pipelineId: "pipe_a", pipelineTenantId: TENANT_A, pipelineActive: true, pipelineDeleted: false },
  { stageId: "stage_b_new", pipelineId: "pipe_b", pipelineTenantId: TENANT_B, pipelineActive: true, pipelineDeleted: false },
  { stageId: "stage_unowned", pipelineId: "pipe_unowned", pipelineTenantId: null, pipelineActive: true, pipelineDeleted: false },
  { stageId: "stage_a_archived", pipelineId: "pipe_a_old", pipelineTenantId: TENANT_A, pipelineActive: false, pipelineDeleted: true },
];

const resolveAs = (actingTenantId: string, stageId: string) =>
  resolveStageParent(stageId, TABLE, pipelineScopeFor({ actingTenantId }));

/* ── 1. the two cases resolve to the same value ──────────────────────────── */

test("a foreign stage id and a missing stage id resolve to the SAME nothing", () => {
  const foreign = resolveAs(TENANT_A, "stage_b_new");
  const missing = resolveAs(TENANT_A, "stage_does_not_exist_anywhere");

  assert.equal(foreign, null, "tenant B's stage must not resolve for tenant A");
  assert.equal(missing, null);
  // Not "both falsy" — IDENTICAL. A resolver that returned null for one and
  // undefined for the other would still be one distinguishable bit downstream.
  assert.deepEqual(foreign, missing);
  assert.equal(Object.is(foreign, missing), true);

  // And it is symmetric: A's stages are equally unreachable from B.
  assert.deepEqual(resolveAs(TENANT_B, "stage_a_new"), resolveAs(TENANT_B, "no_such_stage"));

  // A workspace with no rows at all sees nothing — never "everything", which is
  // what an empty or absent predicate degrades to.
  for (const stageId of TABLE.map((row) => row.stageId)) {
    assert.equal(resolveAs("tenant_third", stageId), null, `tenant_third reached ${stageId}`);
  }
});

test("the workspace that owns the stage still gets its pipeline", () => {
  // The fix must not be "refuse everything", which would pass every assertion
  // above. The owning workspace resolves the parent, and gets the parent's id —
  // the value `moveStage` needs to bound the rest of the operation.
  assert.deepEqual(resolveAs(TENANT_A, "stage_a_new"), { id: "pipe_a", tenantId: TENANT_A, active: true });
  assert.deepEqual(resolveAs(TENANT_B, "stage_b_new"), { id: "pipe_b", tenantId: TENANT_B, active: true });
});

test("an unowned parent belongs to nobody, and an archived one is unreachable", () => {
  // A NULL pipeline tenant is "written by an unknown workspace", not "the founding
  // tenant's" — pipelineScopeFor's rule, applied here rather than restated.
  assert.equal(resolveAs(TENANT_A, "stage_unowned"), null);
  assert.equal(resolveAs(TENANT_B, "stage_unowned"), null);
  // `deletedAt IS NULL` is in the query for the same reason it is in
  // requireOwnedPipeline: an archived pipeline is not an editable one. Its owner
  // gets the same nothing as everybody else, so this is not a third answer either.
  assert.equal(resolveAs(TENANT_A, "stage_a_archived"), null);
  assert.deepEqual(resolveAs(TENANT_A, "stage_a_archived"), resolveAs(TENANT_A, "no_such_stage"));
});

/* ── 2. the two cases RENDER identically, through the real classifier ────── */

/**
 * What the caller actually receives, computed by the production path.
 *
 * `asActionResult` is `server-only` and cannot be imported here, but the decision
 * it delegates to — `classifyFailure` — is not, and it is the whole of the
 * difference: `{ kind: "refusal" }` is returned verbatim and logged nowhere, while
 * `{ kind: "unexpected" }` becomes a generic sentence carrying a reference code and
 * a `console.error` line. So this drives the real function with a fixed reference,
 * which is exactly the seam it was split out for.
 */
const rendered = (act: () => unknown): Failure => {
  try {
    act();
  } catch (error) {
    return classifyFailure(error, "REFXYZ");
  }
  throw new Error("expected the action body to fail");
};

/** The action body's own decision, as it now stands: one resolve, one refusal. */
const moveStageOutcome = (stageId: string): Failure =>
  rendered(() => {
    const pipeline = resolveAs(TENANT_A, stageId);
    if (!pipeline) throw new ActionRefusal(UNREACHABLE_STAGE_MESSAGE);
  });

test("the response and the log are byte-identical for both cases", () => {
  const foreign = moveStageOutcome("stage_b_new"); // exists, tenant B's
  const missing = moveStageOutcome("stage_does_not_exist_anywhere"); // exists nowhere

  assert.deepEqual(foreign, missing, "the two cases must be indistinguishable to the caller");
  assert.equal(foreign.kind, "refusal");
  assert.equal(foreign.message, UNREACHABLE_STAGE_MESSAGE);

  // A refusal carries no logLine at all, so "the same log line" is "no log line",
  // for both. Stated over the union type rather than the narrowed one so a future
  // kind that DID log could not slip past.
  for (const failure of [foreign, missing]) {
    assert.equal("logLine" in failure, false, "a refusal must log nothing");
    assert.doesNotMatch(failure.message, /REFXYZ/, "no reference code may appear on either branch");
    assert.doesNotMatch(failure.message, /pipeline|tenant|workspace/i, "the sentence must not describe the row");
  }

  // An archived parent, and a stage whose parent is unowned, join the same branch.
  assert.deepEqual(moveStageOutcome("stage_a_archived"), missing);
  assert.deepEqual(moveStageOutcome("stage_unowned"), missing);
});

test("the OLD shape really did answer the two differently — the oracle, demonstrated", () => {
  /*
   * Read unscoped, then gate. Both halves are the real ones: the unscoped read is
   * `TABLE.find` with no tenant predicate (which is what `basePrisma` gives you
   * while enforcement is dormant), the gate is `requireOwnedPipeline`'s own
   * `throw new Error("Pipeline not found")`, and the rendering is `classifyFailure`.
   *
   * This is here so the file cannot quietly become vacuous. If someone reinstates
   * the pre-gate read, the assertions above stop describing the code — and this
   * test is the record of what that shape does.
   */
  const oldShape = (stageId: string): Failure =>
    rendered(() => {
      const stage = TABLE.find((row) => row.stageId === stageId); // unscoped read
      if (!stage) throw new ActionRefusal(UNREACHABLE_STAGE_MESSAGE);
      if (!resolveAs(TENANT_A, stageId)) throw new Error("Pipeline not found"); // the gate, after
    });

  const foreign = oldShape("stage_b_new");
  const missing = oldShape("stage_does_not_exist_anywhere");

  assert.notDeepEqual(foreign, missing, "the premise of this branch is that these differed");
  assert.equal(missing.kind, "refusal");
  assert.equal(foreign.kind, "unexpected", "a foreign id got past the read and died at the gate");
  assert.match(foreign.message, /Reference REFXYZ/, "one branch carried a reference code");
  assert.equal("logLine" in foreign, true, "…and one branch wrote a log line");
  assert.equal("logLine" in missing, false, "…while the other wrote none");

  // The bit, named: one `kind`, two values, selected by whether the id exists in
  // some other workspace. That is the oracle, and it is what the fix removes.
  assert.notEqual(foreign.kind, missing.kind);
  assert.notEqual(foreign.message, missing.message);

  // Tenant A's OWN stage is unaffected under either shape — the difference is not
  // "the old code was broken for everyone".
  assert.deepEqual(resolveAs(TENANT_A, "stage_a_new"), { id: "pipe_a", tenantId: TENANT_A, active: true });
});

/* ── 3. …and moveStage is wired to it ────────────────────────────────────── */

const settings = strip(src("src/app/actions/settings.ts"));
const MOVE = settings.slice(
  settings.indexOf("export async function moveStage"),
  settings.indexOf("export async function deleteStage"),
);

test("moveStage resolves the stage THROUGH the boundary, in one statement", () => {
  assert.ok(MOVE.length > 0, "moveStage not found — the slice markers moved");

  assert.match(MOVE, /const pipeline = await findOwnedPipelineForStage\(id\)/);
  assert.match(MOVE, /if \(!pipeline\) refuse\(UNREACHABLE_STAGE_MESSAGE\)/);
  assert.match(settings, /import \{[^}]*findOwnedPipelineForStage[^}]*\} from "@\/lib\/pipelines"/);
  assert.match(settings, /import \{[^}]*UNREACHABLE_STAGE_MESSAGE[^}]*\} from "@\/lib\/pipelineTenantRule"/);

  // THE DEFECT, as the shape that may not come back: any read of a PipelineStage by
  // the bound `id` before something has established ownership.
  assert.doesNotMatch(MOVE, /pipelineStage\.findUnique/, "the pre-gate unscoped stage read is the defect");
  assert.doesNotMatch(MOVE, /pipelineStage\.findFirst/, "same shape, different method name");
  assert.doesNotMatch(
    MOVE,
    /requireOwnedPipeline\(stage\./,
    "gating on a pipelineId that came from an unscoped read is the two-step shape",
  );

  // Everything that touches data must sit AFTER the resolver, not merely after
  // some gate: ordering is the property, so it is asserted by index.
  const gateAt = MOVE.indexOf("await findOwnedPipelineForStage(id)");
  assert.ok(gateAt > 0, "moveStage must resolve the stage through the tenant boundary");
  for (const [what, needle] of [
    ["the stage list", "pipelineStage.findMany"],
    ["the position oracle", "already at the end"],
    ["the reorder", "reorderPipelineStages(pipeline.id, ids)"],
  ] as const) {
    const at = MOVE.indexOf(needle);
    assert.ok(at > 0, `moveStage no longer contains ${what} — the markers moved`);
    assert.ok(gateAt < at, `${what} runs before ownership is established`);
  }

  // Every read after it is bounded by the pipeline the resolver returned, never by
  // anything derived from the raw argument.
  assert.match(MOVE, /where: \{ pipelineId: pipeline\.id \}/);

  // ONE sentence for an id that does not resolve, from the shared constant. Two
  // literals is how the two cases drift apart again.
  assert.doesNotMatch(MOVE, /refuse\("That stage no longer exists/, "the sentence must come from the constant");
  assert.equal(
    (MOVE.match(/refuse\(UNREACHABLE_STAGE_MESSAGE\)/g) ?? []).length,
    2,
    "the unresolvable case and the deleted-in-between race must give the same answer",
  );
});

test("the resolver carries the ownership predicate in the query itself", () => {
  // A resolver that fetched the stage and filtered in JS would satisfy every
  // assertion above and still read the row. The predicate has to be in the SQL, on
  // the PARENT's tenant column, and the join has to be what reaches the stage.
  const lib = strip(src("src/lib/pipelines.ts"));
  const fn = lib.slice(
    lib.indexOf("export async function findOwnedPipelineForStage"),
    lib.indexOf("export async function getOwnedPipelineRow"),
  );
  assert.ok(fn.length > 0, "findOwnedPipelineForStage not found — the slice markers moved");

  assert.match(fn, /FROM "PipelineStage" s\s*\n\s*JOIN "SalesPipeline" p ON p\."id" = s\."pipelineId"/);
  assert.match(fn, /WHERE s\."id" = \$\{stageId\} AND p\."deletedAt" IS NULL \$\{scope\}/);
  // The scope is built from the shared rule, aliased to the PIPELINE — a predicate
  // on the stage's own tenantId would refuse legitimate work, because that column
  // is NULL on every row written while enforcement was dormant.
  assert.match(fn, /pipelineTenantFilter\('p\."tenantId"'\)/);
  assert.match(fn, /pipelineScopeFilter\(actingTenant, 'p\."tenantId"'\)/);
  // Returns nothing rather than throwing, so the caller has ONE branch to render.
  assert.match(fn, /Promise<OwnedPipeline \| null>/);
  assert.match(fn, /return rows\[0\] \?\? null/);
  assert.doesNotMatch(fn, /throw new Error/, "a throw here would be a second outcome to tell apart");
});
