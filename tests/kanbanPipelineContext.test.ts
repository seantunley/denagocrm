import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isStale, matchesOwnerFilter, OWNER_ANY, OWNER_UNASSIGNED } from "../src/lib/kanbanRules";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * The board had no pipeline as its operating context, a global notion of "stale"
 * that ignored per-stage configuration, an owner filter keyed on display names,
 * and an optimistic move that never rolled back.
 */

/* ── stale is the stage's own rule ─────────────────────────────────────── */

test("each stage decides for itself when a card is stale", () => {
  // A three-day Qualification and a thirty-day Negotiation are not the same
  // board, and a single constant said they were.
  assert.equal(isStale(4, 3), true, "4 days in a 3-day stage is stale");
  assert.equal(isStale(4, 30), false, "the same card in a 30-day stage is not");
  assert.equal(isStale(30, 30), true, "the threshold is inclusive");
});

test("a stage with nothing configured falls back rather than never going stale", () => {
  assert.equal(isStale(7, null), true, "the old global default still applies");
  assert.equal(isStale(6, null), false);
  assert.equal(isStale(null, null), false, "an unknown age is not evidence of staleness");
  assert.equal(isStale(undefined, 3), false);
});

test("the threshold reaches the card, not just the filter", () => {
  const board = src("src/components/KanbanBoard.tsx");
  assert.match(board, /staleAfterDays: number \| null;/, "the stage carries it");
  assert.match(board, /staleAfterDays=\{stage\.staleAfterDays\}/, "the column hands it to the card");
  assert.match(board, /isStale\(lead\.ageDays, staleAfterDays\)/, "the badge uses it");
  assert.match(board, /isStale\(lead\.ageDays, stage\.staleAfterDays\)/, "so does 'needs attention'");
  // The global constant must no longer decide anything.
  const code = board.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\bSTALE_DAYS\b(?!.*DEFAULT)/, "no global stale rule survives");
});

/* ── the owner filter is an identity, not a label ──────────────────────── */

type Lead = { assignedToId: string | null };
const matchesOwner = (lead: Lead, owner: string) => matchesOwnerFilter(lead.assignedToId, owner);

test("owner filtering uses the id, so a rename or a namesake cannot break it", () => {
  const mine: Lead = { assignedToId: "u_sean" };
  const theirs: Lead = { assignedToId: "u_other" };
  const nobody: Lead = { assignedToId: null };

  assert.equal(matchesOwner(mine, "u_sean"), true);
  assert.equal(matchesOwner(theirs, "u_sean"), false);
  assert.equal(matchesOwner(nobody, "u_sean"), false);

  // Two people can share a display name; they cannot share an id.
  assert.equal(matchesOwner(theirs, "u_other"), true);

  assert.equal(matchesOwner(nobody, OWNER_UNASSIGNED), true, "Unassigned is a real filter");
  assert.equal(matchesOwner(mine, OWNER_UNASSIGNED), false);
  for (const lead of [mine, theirs, nobody]) {
    assert.equal(matchesOwner(lead, OWNER_ANY), true, "All owners means all");
  }
});

test("the owner list is deduped by id and offers Mine and Unassigned", () => {
  const board = src("src/components/KanbanBoard.tsx");
  assert.match(board, /if \(lead\.assignedToId\) byId\.set\(lead\.assignedToId, lead\.assignee \?\? "Unnamed"\)/);
  // The comparison itself lives in kanbanRules, which the tests above execute.
  assert.match(board, /matchesOwnerFilter\(lead\.assignedToId, owner\)/, "the filter is applied by id");
  // Strip comments: the note explaining the old defect quotes the old comparison.
  const code = board.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /lead\.assignee === owner/, "never on the display name");
  assert.match(board, /currentUserId && <option value=\{currentUserId\}>Mine<\/option>/);
  assert.match(board, /<option value=\{OWNER_UNASSIGNED\}>Unassigned<\/option>/);
});

/* ── a refused move must not leave a false board ───────────────────────── */

test("a rejected move restores exactly what the user was looking at", () => {
  const board = src("src/components/KanbanBoard.tsx");
  // Snapshot BEFORE the optimistic move, or the rollback restores the wrong thing.
  const requestMove = board.slice(board.indexOf("function requestMove("), board.indexOf("function onDragEnd("));
  const snapshotAt = requestMove.indexOf("const snapshot = stages;");
  const applyAt = requestMove.indexOf("applyMove(lead.id");
  assert.ok(snapshotAt >= 0 && applyAt > snapshotAt, "the snapshot must precede the optimistic move");
  assert.match(requestMove, /if \(!result\.ok\) rollbackTo\(snapshot/, "a refusal must roll back");
  // A transport failure has to roll back too, or the board keeps a card in a
  // column the server never accepted.
  assert.match(requestMove, /\.catch\(\(\) => \(\{[\s\S]{0,120}ok: false as const/);
  // The old behaviour: a toast and nothing else, leaving the card where the
  // server refused to put it.
  assert.doesNotMatch(requestMove, /catch \(\) => \{\s*toast\.error/);

  // The test-drive path moves the card too, and can be refused the same way.
  const confirm = board.slice(board.indexOf("function confirmTestDrive("), board.indexOf("function removeLead("));
  assert.match(confirm, /const snapshot = stages;/);
  assert.match(confirm, /rollbackTo\(snapshot, result\.error/);
});

/**
 * The rollback is the first code on this board that tries to DISPLAY a refusal,
 * and `moveLead` was the only action it calls that signalled one by throwing.
 * Next's guidance for Server Functions is the opposite — "avoid using try/catch
 * blocks and throw errors. Instead, model expected errors as return values"
 * (node_modules/next/dist/docs/01-app/01-getting-started/10-error-handling.md) —
 * and every sibling the board calls already returns `{ ok, error }`.
 */
test("a refused move is a return value, not a throw", () => {
  const actions = src("src/app/actions/leads.ts");
  const moveLead = actions.slice(
    actions.indexOf("export async function moveLead("),
    actions.indexOf("export async function moveLeadToTestDrive("),
  );
  assert.ok(moveLead.length > 0, "moveLead must still exist");
  // `gate?: StageGateVerdict` joined this in the stage-gates change. It is
  // additive and does not weaken the property under test: a refusal is still a
  // returned `{ ok: false }`, and the verdict rides along so the board can open
  // the reason dialog because the SERVER asked it to. The `ok`/`error` pair is
  // still asserted exactly.
  assert.match(
    moveLead,
    /Promise<\{ ok: boolean; error\?: string; gate\?: StageGateVerdict \}>/,
    "the signature says so",
  );
  assert.match(moveLead, /return \{ ok: false, error: "You do not have permission to move leads between pipelines" \}/);
  assert.match(moveLead, /return \{ ok: false, error: "This stage requires test-drive booking details" \}/);
  assert.match(moveLead, /return \{ ok: true \};/, "the success path must report success");
  // Bare throws are what produced a digest on the client and a hash in the toast.
  const code = moveLead.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /throw new Error\(/, "an expected refusal must not be thrown");

  // The shared stage lookup has the same two shapes: a value for the callers that
  // return, a refusal for the ones inside asActionResult.
  const resolve = actions.slice(actions.indexOf("async function resolveOpenStage("), actions.indexOf("export async function createLead("));
  assert.match(resolve, /return \{ error: "Selected pipeline stage does not exist" \}/);
  assert.match(resolve, /if \("error" in resolved\) throw new ActionRefusal\(resolved\.error\)/);
  assert.doesNotMatch(
    resolve.slice(0, resolve.indexOf("async function validateOpenStage(")),
    /throw /,
    "the value form must not throw",
  );
});

/* ── one pipeline is the board's context ───────────────────────────────── */

test("the board reads one pipeline's stages, not every stage there is", () => {
  const page = src("src/app/(app)/leads/page.tsx");
  assert.match(page, /const \{ pipeline: requestedPipeline \} = await searchParams;/);
  assert.match(page, /where: activePipeline \? \{ id: \{ in: \[\.\.\.stageMeta\.keys\(\)\] \} \} : \{ id: \{ in: \[\] \} \}/);
  // An unrecognised ?pipeline= must not silently widen to everything.
  assert.match(page, /pipelines\.find\(\(p\) => p\.id === requestedPipeline\) \?\? pipelines\[0\] \?\? null/);
});

test("All pipelines is a summary, never a mixed draggable board", () => {
  const page = src("src/app/(app)/leads/page.tsx");
  assert.match(page, /allPipelines \? \(/);
  assert.match(page, /<PipelineSummary pipelines=\{pipelineSummaries\} \/>/);
  // The board is rendered only for a single pipeline.
  const boardAt = page.indexOf("<KanbanBoard");
  const summaryAt = page.indexOf("<PipelineSummary");
  assert.ok(summaryAt >= 0 && boardAt > summaryAt, "the summary is the other branch of the same condition");

  const summary = src("src/components/PipelineSummary.tsx");
  assert.doesNotMatch(summary, /useDraggable|useDroppable|DndContext/, "a summary must not be draggable");
});

test("cards are ordered by the position the server persists", () => {
  const page = src("src/app/(app)/leads/page.tsx");
  assert.match(page, /orderBy: \[\{ position: "asc" \}, \{ createdAt: "desc" \}\]/);
  // And the move actually writes one, or the ordering key never changes.
  assert.match(src("src/app/actions/leads.ts"), /position: await nextPosition\(stageId\)/);
});

/* ── SalesPipeline was never tenant-scoped at all ──────────────────────── */

/**
 * The review's 3.1, and the asymmetry that gives it away: the PipelineStage and
 * Lead helpers in this very file call `tenantFilter(...)`, while every
 * SalesPipeline path used `basePrisma` — the documented RLS BYPASS — with no
 * tenant predicate at all.
 *
 * It was not only a read leak. `createPipeline` and `updatePipeline` clear the
 * default with `UPDATE "SalesPipeline" SET "isDefault" = false WHERE "deletedAt"
 * IS NULL`, so making a pipeline default in one workspace cleared it in EVERY
 * other one — a silent cross-tenant write on the dependency `getDefaultPipeline`
 * uses to create leads.
 */

test("every SalesPipeline statement carries a tenant predicate", () => {
  const lib = src("src/lib/pipelines.ts");
  const code = lib.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // Each statement touching SalesPipeline, with the scope interpolation it uses.
  const statements = [...code.matchAll(/(?:SELECT|INSERT INTO|UPDATE)[\s\S]{0,420}?"SalesPipeline"[\s\S]{0,420}?`/g)]
    .map((m) => m[0]);
  assert.ok(statements.length >= 6, `expected the SalesPipeline statements, found ${statements.length}`);

  for (const statement of statements) {
    const scoped =
      /\$\{scope\}|\$\{writeScope\}|\$\{pipelineScope\}|"tenantId"\)/.test(statement) ||
      /INSERT INTO "SalesPipeline"[\s\S]*"tenantId"/.test(statement);
    assert.ok(scoped, `a SalesPipeline statement has no tenant predicate:\n${statement.slice(0, 200)}`);
  }
});

test("the default-clear cannot reach another workspace", () => {
  const lib = src("src/lib/pipelines.ts");
  // The exact shape of the cross-tenant write, which must no longer exist.
  assert.doesNotMatch(
    lib,
    /SET "isDefault" = false, "updatedAt" = CURRENT_TIMESTAMP WHERE "deletedAt" IS NULL`/,
    "an unscoped default-clear wipes every other tenant's default",
  );
  assert.match(lib, /WHERE "deletedAt" IS NULL \$\{scope\}`/);
  assert.match(lib, /WHERE "id" <> \$\{id\} AND "deletedAt" IS NULL \$\{scope\}`/);
});

test("a new pipeline is born owned", () => {
  const lib = src("src/lib/pipelines.ts");
  assert.match(lib, /INSERT INTO "SalesPipeline" \("id", "name", "description", "type", "isDefault", "tenantId"\)/);
  assert.match(lib, /const tenantId = await actingTenantId\(\);/);
});

test("the pipeline predicate resolves the acting workspace, not the dormant scope", () => {
  // tenantFilter() returns Prisma.empty while enforcement is dormant, which is
  // today — fine on top of an already-scoped client, useless on basePrisma.
  const lib = src("src/lib/pipelines.ts");
  const fn = lib.slice(
    lib.indexOf("async function pipelineTenantFilter"),
    lib.indexOf("/** A pipeline as its OWNER row"),
  );
  assert.match(fn, /await actingTenantId\(\)/);
  // The decision itself moved to pipelineTenantRule.ts, where a test EXECUTES it
  // with two tenant ids — see tests/pipelineTenantIsolation.test.ts. What is left
  // here is the seam, and the seam must not hold a second, divergent copy.
  assert.match(fn, /pipelineScopeSql\(pipelineScopeFor\(/);
  assert.doesNotMatch(fn, /Prisma\.sql/, "no hand-rolled predicate beside the shared one");
  // The "tenantId IS NULL means the founding tenant" rule this shipped with is
  // gone: both July backfills already claimed every legacy NULL, so a NULL row
  // today was written by the bug being fixed and may belong to a second tenant.
  assert.doesNotMatch(fn, /IS NULL/);
});
