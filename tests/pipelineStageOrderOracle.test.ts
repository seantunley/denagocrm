import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  pipelineRowVisible,
  pipelineScopeFor,
  resolveStageParent,
  UNREACHABLE_STAGE_MESSAGE,
  type StageParentRow,
} from "../src/lib/pipelineTenantRule";
import { ActionRefusal, classifyFailure, type Failure } from "../src/lib/actionFailure";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";

/**
 * THE SECOND INSTANCE OF #476'S ORACLE, IN A DIFFERENT FILE AND BY A DIFFERENT ROUTE.
 *
 * #476 fixed `moveStage` in src/app/actions/settings.ts, where a forgeable STAGE id
 * was read on `basePrisma` before anything checked ownership. The same-named
 * `moveStage` in src/app/actions/pipelines.ts — a separate action, wired to the
 * /settings/pipelines screen — had the identical defect keyed by the forgeable
 * PARENT id instead:
 *
 *     const stages = await listPipelineStages(pipelineId);   // ← first line, no gate
 *
 * `listPipelineStages` is scoped by `tenantFilter`, which returns `Prisma.empty`
 * whenever `tenantEnforcing()` is false — which is every environment we run — and
 * runs on `basePrisma`, the documented RLS bypass. So a forged `pipelineId` returned
 * another workspace's whole ORDERED stage list, and the exits then differed:
 *
 *   stage not in the list        → refuse("That stage no longer exists …")  verbatim
 *   in the list, at the end      → refuse("That stage is already at the end.") verbatim
 *   in the list, and can move    → reorderPipelineStages → requireOwnedPipeline →
 *                                  throw Error("Pipeline not found") → the generic
 *                                  sentence, a reference code, and a log line
 *
 * A pipeline id that exists NOWHERE lands in the first of those. So the caller could
 * read two things they have no other way to learn: whether a pipeline id exists in
 * some other workspace, and — by asking "up" and then "down" — where a stage sits in
 * that workspace's list. `editSalesPipelineStage` in the same file leaked the first
 * of those by a third route, through the equally unscoped `getPipelineStage`.
 *
 * WHAT THIS FILE PROVES, in #476's method — EXECUTING the decision rather than
 * describing it:
 *
 *   1. every unreachable case (foreign pipeline, absent pipeline, foreign stage,
 *      stage/pipeline mismatch) renders through the REAL `classifyFailure` to one
 *      deep-equal outcome: same kind, same message, no reference code, no log line;
 *   2. the POSITION is no longer measurable — probing every stage of a foreign
 *      pipeline in both directions yields ONE distinct answer, and it is the answer
 *      an id that exists nowhere gets;
 *   3. the OLD shape, driven through the same real classifier, yields THREE distinct
 *      answers over that same probe — so the oracle is demonstrated, not asserted,
 *      and this file cannot go vacuous if the fix is reverted;
 *   4. the owning workspace still reorders its own stages;
 *   5. both actions are actually wired to the gate, with nothing read in front of it.
 *
 * `src/app/actions/pipelines.ts` and `src/lib/pipelines.ts` reach `server-only`,
 * which `node:test` cannot load, so (1)-(4) run against the rules in
 * `pipelineTenantRule.ts` — the module the production SQL is built from — and (5)
 * is checked against the action's source text with comments stripped.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const TENANT_A = DEFAULT_TENANT_ID; // the workspace doing the asking
const TENANT_B = "tenant_second_dealer";
const SCOPE_A = pipelineScopeFor({ actingTenantId: TENANT_A });

/**
 * Two workspaces' pipelines and stages in one table, as `findOwnedPipelineForStage`
 * selects them: every ownership fact comes off the PARENT, because a stage's own
 * `tenantId` is NULL on everything written while enforcement was dormant.
 *
 * Tenant B's pipeline deliberately has THREE stages, so "first", "middle" and "last"
 * are all reachable — that is what makes the position oracle measurable rather than
 * hypothetical.
 */
const PIPELINES: Array<{ id: string; tenantId: string | null; deleted: boolean; stages: string[] }> = [
  { id: "pipe_a", tenantId: TENANT_A, deleted: false, stages: ["stage_a1", "stage_a2", "stage_a3"] },
  // A SECOND pipeline owned by the same workspace: the stage/parent pair can be
  // mismatched without either half being foreign.
  { id: "pipe_a_other", tenantId: TENANT_A, deleted: false, stages: ["stage_a_other"] },
  { id: "pipe_b", tenantId: TENANT_B, deleted: false, stages: ["stage_b1", "stage_b2", "stage_b3"] },
  { id: "pipe_unowned", tenantId: null, deleted: false, stages: ["stage_unowned"] },
  { id: "pipe_a_archived", tenantId: TENANT_A, deleted: true, stages: ["stage_a_archived"] },
];

const TABLE: StageParentRow[] = PIPELINES.flatMap((pipeline) =>
  pipeline.stages.map((stageId) => ({
    stageId,
    pipelineId: pipeline.id,
    pipelineTenantId: pipeline.tenantId,
    pipelineActive: !pipeline.deleted,
    pipelineDeleted: pipeline.deleted,
  })),
);

/** `listPipelineStages(pipelineId)` while dormant: keyed by the parent id, NO tenant predicate. */
const unscopedStageList = (pipelineId: string): string[] =>
  PIPELINES.find((pipeline) => pipeline.id === pipelineId)?.stages ?? [];

/** `requireOwnedPipeline`'s predicate, keyed by the parent id — the real rule, not a copy. */
const pipelineIsOurs = (pipelineId: string): boolean => {
  const pipeline = PIPELINES.find((row) => row.id === pipelineId);
  if (!pipeline || pipeline.deleted) return false;
  return pipelineRowVisible(pipeline.tenantId, SCOPE_A);
};

type Direction = "up" | "down";
/** A refusal/fault, or the order the pipeline would end up in. Successes compare too. */
type Outcome = Failure | { kind: "moved"; order: readonly string[] };

/**
 * What the caller actually receives, computed by the production path.
 *
 * `asActionResult` is `server-only`, but the decision it delegates to —
 * `classifyFailure` — is not, and it is the whole of the difference: a `refusal` is
 * returned verbatim and logged nowhere, while an `unexpected` becomes a generic
 * sentence carrying a reference code plus a `console.error` line. So the real
 * function is driven with a fixed reference, which is the seam it was split out for.
 */
const outcomeOf = (act: () => readonly string[]): Outcome => {
  try {
    return { kind: "moved", order: act() };
  } catch (error) {
    return classifyFailure(error, "REFXYZ");
  }
};

const swap = (order: readonly string[], from: number, to: number) => {
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
};

/** `moveStage` in src/app/actions/pipelines.ts AS IT NOW STANDS: gate, then list. */
const moveStage = (pipelineId: string, stageId: string, direction: Direction): Outcome =>
  outcomeOf(() => {
    const pipeline = resolveStageParent(stageId, TABLE, SCOPE_A);
    if (!pipeline || pipeline.id !== pipelineId) throw new ActionRefusal(UNREACHABLE_STAGE_MESSAGE);
    const stages = unscopedStageList(pipeline.id);
    const idx = stages.indexOf(stageId);
    if (idx < 0) throw new ActionRefusal(UNREACHABLE_STAGE_MESSAGE);
    const swapWith = direction === "up" ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= stages.length) throw new ActionRefusal("That stage is already at the end.");
    return swap(stages, idx, swapWith);
  });

/** THE DEFECT: list first on the forgeable parent id, gate at the write. */
const moveStageBeforeTheFix = (pipelineId: string, stageId: string, direction: Direction): Outcome =>
  outcomeOf(() => {
    const stages = unscopedStageList(pipelineId); // listPipelineStages — Prisma.empty while dormant
    const idx = stages.indexOf(stageId);
    if (idx < 0) throw new ActionRefusal("That stage no longer exists — reload the page.");
    const swapWith = direction === "up" ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= stages.length) throw new ActionRefusal("That stage is already at the end.");
    // reorderPipelineStages → requireOwnedPipeline, which fails by THROWING.
    if (!pipelineIsOurs(pipelineId)) throw new Error("Pipeline not found");
    return swap(stages, idx, swapWith);
  });

/* ── 1. every unreachable case is the same one answer ─────────────────────── */

/** The baseline every refusal below must be indistinguishable from. */
const ABSENT = moveStage("pipe_nowhere", "stage_nowhere", "down");

test("a foreign pipeline and a pipeline that exists nowhere get the SAME answer", () => {
  const foreign = moveStage("pipe_b", "stage_b1", "down"); // exists, tenant B's, movable

  assert.deepEqual(foreign, ABSENT, "the two cases must be indistinguishable to the caller");
  assert.equal(foreign.kind, "refusal");
  assert.equal("message" in foreign && foreign.message, UNREACHABLE_STAGE_MESSAGE);

  // A refusal carries no logLine at all, so "the same log line" is "no log line", for
  // both. Stated over the union type rather than a narrowed one, so a future kind
  // that DID log could not slip past.
  for (const failure of [foreign, ABSENT]) {
    assert.equal("logLine" in failure, false, "a refusal must log nothing");
    assert.equal("order" in failure, false, "neither case may reach the write");
    assert.doesNotMatch(
      "message" in failure ? failure.message : "",
      /REFXYZ/,
      "no reference code may appear on either branch",
    );
    assert.doesNotMatch(
      "message" in failure ? failure.message : "",
      /pipeline|tenant|workspace/i,
      "the sentence must not describe the row",
    );
  }
});

test("foreign, unowned, archived and mismatched all land on that same answer", () => {
  const cases: Array<[string, string, string]> = [
    ["a foreign stage claimed under our own pipeline", "pipe_a", "stage_b1"],
    ["our own stage claimed under a foreign pipeline", "pipe_b", "stage_a1"],
    ["a stage of ours claimed under the wrong pipeline of ours", "pipe_a", "stage_a_other"],
    ["a pipeline nobody owns", "pipe_unowned", "stage_unowned"],
    ["an archived pipeline of our own", "pipe_a_archived", "stage_a_archived"],
    ["a stage that exists nowhere, under a real pipeline", "pipe_a", "stage_nowhere"],
  ];
  for (const [what, pipelineId, stageId] of cases) {
    for (const direction of ["up", "down"] as const) {
      assert.deepEqual(moveStage(pipelineId, stageId, direction), ABSENT, `${what} is distinguishable`);
    }
  }
});

type Shape = (pipelineId: string, stageId: string, direction: Direction) => Outcome;

/** The probe an attacker would actually run: every stage of the target, both ways. */
const B_STAGES = PIPELINES.find((pipeline) => pipeline.id === "pipe_b")!.stages;
const foreignAnswers = (shape: Shape) =>
  B_STAGES.flatMap((stageId) => (["up", "down"] as const).map((d) => JSON.stringify(shape("pipe_b", stageId, d))));
/** The same probe read as ONE up/down pair per stage — which is what locates it. */
const foreignPairs = (shape: Shape) =>
  B_STAGES.map((stageId) => JSON.stringify((["up", "down"] as const).map((d) => shape("pipe_b", stageId, d))));

test("the POSITION of a stage in a foreign pipeline is no longer measurable", () => {
  // ONE answer across the whole probe — and it is the answer an id that exists
  // nowhere gets, so the probe distinguishes neither the stages from each other nor
  // the pipeline from nothing.
  assert.deepEqual([...new Set(foreignAnswers(moveStage))], [JSON.stringify(ABSENT)]);
  assert.equal(new Set(foreignPairs(moveStage)).size, 1, "up and down must not differ either");

  // …and the same holds for every pipeline this workspace cannot reach, not just
  // tenant B's: unowned parents and our own archived one included.
  const everyUnreachable = new Set(
    PIPELINES.flatMap((pipeline) =>
      pipeline.tenantId === TENANT_A && !pipeline.deleted
        ? []
        : pipeline.stages.flatMap((stageId) =>
            (["up", "down"] as const).map((d) => JSON.stringify(moveStage(pipeline.id, stageId, d))),
          ),
    ),
  );
  assert.deepEqual([...everyUnreachable], [JSON.stringify(ABSENT)]);
});

test("the workspace that owns the pipeline still reorders it", () => {
  // The fix must not be "refuse everything", which would satisfy every assertion
  // above. The owner moves their own stages, and the resulting order is the real one.
  assert.deepEqual(moveStage("pipe_a", "stage_a2", "up"), {
    kind: "moved",
    order: ["stage_a2", "stage_a1", "stage_a3"],
  });
  assert.deepEqual(moveStage("pipe_a", "stage_a2", "down"), {
    kind: "moved",
    order: ["stage_a1", "stage_a3", "stage_a2"],
  });
  // …and the end-of-list sentence is still theirs to see: it is a fact about a
  // pipeline they are looking at, not about somebody else's.
  const atTheEnd = moveStage("pipe_a", "stage_a3", "down");
  assert.equal(atTheEnd.kind, "refusal");
  assert.equal("message" in atTheEnd && atTheEnd.message, "That stage is already at the end.");
  assert.notDeepEqual(atTheEnd, ABSENT, "this branch is only reachable inside your own pipeline");

  // Tenant B is symmetric — this is a boundary, not a blocklist.
  const scopeB = pipelineScopeFor({ actingTenantId: TENANT_B });
  assert.deepEqual(resolveStageParent("stage_b1", TABLE, scopeB), {
    id: "pipe_b",
    tenantId: TENANT_B,
    active: true,
  });
  assert.equal(resolveStageParent("stage_a1", TABLE, scopeB), null);
});

/* ── 2. …and the OLD shape really did answer them differently ─────────────── */

test("the OLD shape leaked existence AND position — the oracle, demonstrated", () => {
  const absent = moveStageBeforeTheFix("pipe_nowhere", "stage_nowhere", "down");
  const foreignMovable = moveStageBeforeTheFix("pipe_b", "stage_b1", "down"); // first → can move
  const foreignAtTheEnd = moveStageBeforeTheFix("pipe_b", "stage_b1", "up"); // first → cannot

  // Existence: a foreign pipeline answered differently from one that is nowhere.
  assert.notDeepEqual(foreignMovable, absent, "the premise of this branch is that these differed");
  assert.equal(absent.kind, "refusal");
  assert.equal(foreignMovable.kind, "unexpected", "a forged parent got past the list and died at the write");
  assert.match(
    "message" in foreignMovable ? foreignMovable.message : "",
    /Reference REFXYZ/,
    "one branch carried a reference code",
  );
  assert.equal("logLine" in foreignMovable, true, "…and one branch wrote a log line");
  assert.equal("logLine" in absent, false, "…while the other wrote none");

  // Position: the SAME foreign stage answered differently up versus down, which is
  // how "where does it sit in their list" gets read one bit at a time.
  assert.notDeepEqual(foreignAtTheEnd, foreignMovable);
  assert.equal("message" in foreignAtTheEnd && foreignAtTheEnd.message, "That stage is already at the end.");

  // The same probe as the test above, on the same rows.
  //
  // TWO distinct single answers, NEITHER of them the not-there answer: that is the
  // existence bit, readable from any one request.
  assert.deepEqual(new Set(foreignAnswers(moveStageBeforeTheFix)).size, 2);
  assert.equal(
    new Set(foreignAnswers(moveStageBeforeTheFix)).has(JSON.stringify(absent)),
    false,
    "neither answer was the one an id that exists nowhere gets",
  );
  // And THREE distinct up/down PAIRS over a three-stage pipeline — which is the
  // position, recovered exactly: (refusal, fault) is first, (fault, fault) is middle,
  // (fault, refusal) is last. Two requests per stage and tenant B's ordering is out.
  assert.equal(new Set(foreignPairs(moveStageBeforeTheFix)).size, 3, "first, middle and last were tellable apart");
  // The fixed shape collapses both of those to one answer and one pair.
  assert.equal(new Set(foreignAnswers(moveStage)).size, 1);
  assert.equal(new Set(foreignPairs(moveStage)).size, 1);

  // Tenant A's own pipeline behaved the same under both shapes: the defect was a
  // leak, not a breakage, which is exactly why it survived review.
  assert.deepEqual(moveStageBeforeTheFix("pipe_a", "stage_a2", "up"), moveStage("pipe_a", "stage_a2", "up"));
});

/* ── 3. the same, for editSalesPipelineStage ──────────────────────────────── */

/**
 * `getPipelineStage(id)` is scoped by the same dormant `tenantFilter`, so the edit
 * action resolved any workspace's stage and only `updatePipelineStage`'s own
 * `requireOwnedPipeline` refused — one throw too late, and by throwing.
 */
const editStage = (stageId: string, name: string): Outcome =>
  outcomeOf(() => {
    const pipeline = resolveStageParent(stageId, TABLE, SCOPE_A);
    if (!pipeline) throw new ActionRefusal(UNREACHABLE_STAGE_MESSAGE);
    const before = TABLE.find((row) => row.stageId === stageId && row.pipelineId === pipeline.id);
    if (!before) throw new ActionRefusal(UNREACHABLE_STAGE_MESSAGE);
    if (!name) throw new ActionRefusal("Stage name is required");
    return [stageId];
  });

const editStageBeforeTheFix = (stageId: string, name: string): Outcome =>
  outcomeOf(() => {
    const before = TABLE.find((row) => row.stageId === stageId); // getPipelineStage — unscoped
    if (!before) throw new ActionRefusal("Pipeline stage not found");
    if (!name) throw new ActionRefusal("Stage name is required");
    if (!pipelineIsOurs(before.pipelineId)) throw new Error("Pipeline not found"); // updatePipelineStage
    return [stageId];
  });

test("editSalesPipelineStage answers a foreign id and an absent id identically", () => {
  for (const name of ["Qualified", ""]) {
    const foreign = editStage("stage_b1", name);
    const missing = editStage("stage_nowhere", name);
    assert.deepEqual(foreign, missing, `name=${JSON.stringify(name)} is distinguishable`);
    assert.equal(foreign.kind, "refusal");
    assert.equal("message" in foreign && foreign.message, UNREACHABLE_STAGE_MESSAGE);
    assert.equal("logLine" in foreign, false);
  }
  // The unowned and archived parents join the same branch, and the owner is unharmed.
  assert.deepEqual(editStage("stage_unowned", "X"), editStage("stage_nowhere", "X"));
  assert.deepEqual(editStage("stage_a_archived", "X"), editStage("stage_nowhere", "X"));
  assert.deepEqual(editStage("stage_a1", "Qualified"), { kind: "moved", order: ["stage_a1"] });
});

test("…and the OLD edit shape answered them differently, with and without a name", () => {
  // With a name: the foreign id ran on to the write's gate and came back as a fault.
  const foreign = editStageBeforeTheFix("stage_b1", "Qualified");
  const missing = editStageBeforeTheFix("stage_nowhere", "Qualified");
  assert.notDeepEqual(foreign, missing);
  assert.equal(foreign.kind, "unexpected");
  assert.equal(missing.kind, "refusal");

  // WITHOUT a name — a request that never intended to write anything — the two came
  // back as two different verbatim sentences. The cheapest possible probe.
  const foreignBlank = editStageBeforeTheFix("stage_b1", "");
  const missingBlank = editStageBeforeTheFix("stage_nowhere", "");
  assert.equal(foreignBlank.kind, "refusal");
  assert.equal(missingBlank.kind, "refusal");
  assert.notDeepEqual(foreignBlank, missingBlank);
  assert.equal("message" in foreignBlank && foreignBlank.message, "Stage name is required");
  assert.equal("message" in missingBlank && missingBlank.message, "Pipeline stage not found");
});

/* ── 4. …and the actions are wired to it ──────────────────────────────────── */

const actions = strip(src("src/app/actions/pipelines.ts"));
const slice = (from: string, to: string) => actions.slice(actions.indexOf(from), actions.indexOf(to));
const MOVE = slice("export async function moveStage", "export async function archiveSalesPipeline");
const EDIT = slice("export async function editSalesPipelineStage", "export async function moveStage");

test("moveStage gates on ownership before it reads any list", () => {
  assert.ok(MOVE.length > 0, "moveStage not found — the slice markers moved");

  assert.match(MOVE, /const pipeline = await findOwnedPipelineForStage\(stageId\)/);
  assert.match(MOVE, /if \(!pipeline \|\| pipeline\.id !== pipelineId\) refuse\(UNREACHABLE_STAGE_MESSAGE\)/);
  assert.match(actions, /import \{[^}]*findOwnedPipelineForStage[^}]*\} from "@\/lib\/pipelines"/);
  assert.match(actions, /import \{ UNREACHABLE_STAGE_MESSAGE \} from "@\/lib\/pipelineTenantRule"/);

  // THE DEFECT, as the shape that may not come back: the stage list read on the
  // forgeable argument rather than on the pipeline the gate returned. Asserted
  // separately from the ordering below, because a partial revert — gate kept, list
  // moved back in front of it — reinstates the leak while leaving the gate present.
  assert.doesNotMatch(MOVE, /listPipelineStages\(pipelineId\)/, "the list must be bounded by the GATE's answer");
  assert.match(MOVE, /const stages = await listPipelineStages\(pipeline\.id\)/);
  assert.match(MOVE, /await reorderPipelineStages\(pipeline\.id, ids\)/);

  // Ordering is the property, so it is asserted by index rather than by presence.
  const gateAt = MOVE.indexOf("await findOwnedPipelineForStage(stageId)");
  assert.ok(gateAt > 0, "moveStage must resolve the stage through the tenant boundary");
  for (const [what, needle] of [
    ["the stage list", "listPipelineStages(pipeline.id)"],
    ["the position oracle", "already at the end"],
    ["the reorder", "reorderPipelineStages(pipeline.id, ids)"],
    ["the audit write", "logAuditStrict"],
  ] as const) {
    const at = MOVE.indexOf(needle);
    assert.ok(at > 0, `moveStage no longer contains ${what} — the markers moved`);
    assert.ok(gateAt < at, `${what} runs before ownership is established`);
  }
});

test("moveStage refuses an unreachable id with the shared sentence, twice", () => {
  // A SEPARATE property from the ordering above: a gate in the right place that
  // refuses in two different wordings still hands back the bit. Two literals is how
  // the two cases drift apart again, which is why #476 made it a constant.
  assert.ok(MOVE.length > 0, "moveStage not found — the slice markers moved");
  assert.doesNotMatch(MOVE, /refuse\("That stage no longer exists/, "the sentence must come from the constant");
  assert.equal(
    (MOVE.match(/refuse\(UNREACHABLE_STAGE_MESSAGE\)/g) ?? []).length,
    2,
    "the unresolvable case and the deleted-in-between race must give the same answer",
  );
  // The one sentence the caller may still be told that is NOT the shared one, and it
  // is only reachable inside a pipeline the gate has already proved is theirs.
  assert.equal((MOVE.match(/refuse\("/g) ?? []).length, 1);
  assert.match(MOVE, /refuse\("That stage is already at the end\."\)/);
});

test("editSalesPipelineStage gates before the snapshot read", () => {
  assert.ok(EDIT.length > 0, "editSalesPipelineStage not found — the slice markers moved");

  const gateAt = EDIT.indexOf("await findOwnedPipelineForStage(id)");
  assert.ok(gateAt > 0, "editSalesPipelineStage must resolve the stage through the tenant boundary");
  assert.match(EDIT, /if \(!pipeline\) refuse\(UNREACHABLE_STAGE_MESSAGE\)/);
  for (const needle of ["getPipelineStage(id)", "logAuditStrict", "updatePipelineStage(id, after)"]) {
    const at = EDIT.indexOf(needle);
    assert.ok(at > 0, `editSalesPipelineStage no longer contains ${needle} — the markers moved`);
    assert.ok(gateAt < at, `${needle} runs before ownership is established`);
  }
  // The old sentence told a foreign id apart from an absent one. It may not return.
  assert.doesNotMatch(EDIT, /Pipeline stage not found/);
  assert.equal((EDIT.match(/refuse\(UNREACHABLE_STAGE_MESSAGE\)/g) ?? []).length, 2);
});

test("neither the message nor the resolver was duplicated to get here", () => {
  // The point of #476's constant is that ONE sentence covers both cases; a second
  // copy of it, or a second stage→parent resolver, is how they drift apart again.
  const rule = src("src/lib/pipelineTenantRule.ts");
  assert.equal(
    (rule.match(/That stage no longer exists/g) ?? []).length,
    1,
    "the sentence lives in exactly one place",
  );
  const lib = strip(src("src/lib/pipelines.ts"));
  assert.equal(
    (lib.match(/export async function findOwnedPipelineForStage/g) ?? []).length,
    1,
    "one resolver, shared by both files",
  );
  assert.doesNotMatch(actions, /\$queryRaw[\s\S]*"PipelineStage"/, "the actions must not grow their own stage read");
});
