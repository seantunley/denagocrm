import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * The ordinary canvas Save was the one draft writer with no optimistic
 * concurrency. Two tabs open the same flow; the first rewrites the booking
 * branch and saves; the second saves an older graph; the first tab's work is gone
 * with no warning to either person.
 *
 * AI drafting, version restore and block insertion all already fence their
 * writes — this brings the last one into line rather than inventing a new scheme.
 */

/**
 * Model the server's conditional write. There is deliberately NO unfenced path:
 * an optional stamp let a caller opt out of the very invariant this enforces.
 */
function fencedSave(row: { updatedAt: string }, expectedUpdatedAt: string): "written" | "refused" {
  return row.updatedAt === expectedUpdatedAt ? "written" : "refused";
}

test("a save carrying a stale stamp is refused; a fresh one succeeds", () => {
  const loadedByBothTabs = "2026-08-10T10:00:00.000Z";
  const row = { updatedAt: loadedByBothTabs };

  // Tab A saves first and moves the draft on.
  assert.equal(fencedSave(row, loadedByBothTabs), "written");
  row.updatedAt = "2026-08-10T10:05:00.000Z";

  // Tab B still holds the stamp from when it loaded, and must NOT win.
  assert.equal(fencedSave(row, loadedByBothTabs), "refused");

  // Once tab B reloads, it can save again.
  assert.equal(fencedSave(row, row.updatedAt), "written");
});

test("a writer landing between the write and the stamp read cannot be adopted", () => {
  // The hole in the first version: updateMany then a SEPARATE findUnique. Another
  // legitimate writer could land in between, and this tab would adopt THEIR
  // timestamp without ever having seen their definition — its next save would then
  // overwrite their work with no conflict. The same lost update, narrower window.
  const row = { updatedAt: "T1", definition: "A" };
  const loaded = "T1";

  // One transaction: the conditional write and the read of what it produced.
  const save = (expected: string, definition: string) => {
    if (row.updatedAt !== expected) return { conflict: true as const };
    row.definition = definition;
    row.updatedAt = `T${Number(row.updatedAt.slice(1)) + 1}`;
    // Read INSIDE the same transaction — cannot observe a later writer.
    return { ok: true as const, updatedAt: row.updatedAt };
  };

  const mine = save(loaded, "B");
  assert.equal(mine.ok, true);
  assert.equal(mine.updatedAt, "T2", "the stamp adopted must be the one THIS write produced");

  // A different writer moves the draft on afterwards.
  const theirs = save("T2", "C");
  assert.equal(theirs.ok, true);

  // My next save still holds T2 and must be refused, not silently win.
  assert.equal(save(mine.updatedAt!, "D").conflict, true);
  assert.equal(row.definition, "C", "the other writer's work survives");
});

test("the server fences the write and reports the conflict rather than swallowing it", () => {
  const action = src("src/app/actions/flow.ts");
  const save = action.slice(action.indexOf("export async function saveFlow"), action.indexOf("export async function resetFlow"));
  assert.match(save, /where: \{ id, updatedAt: expected \}/, "the save must be fenced");
  assert.match(save, /written\.count !== 1/, "and must notice when it did not land");
  assert.match(save, /conflict: true/, "the caller needs to know it was a conflict, not a generic failure");
  // Losing work silently is the defect; the refusal has to be explained.
  assert.match(save, /changed somewhere else after you opened it/);

  // The conditional write and the read of the stamp it produced must be ONE
  // transaction. Reading it separately lets another writer land in between, and
  // this tab would adopt THEIR timestamp without having seen their definition.
  assert.match(save, /prisma\.\$transaction\(async \(tx\) =>/);
  assert.match(save, /tx\.botFlow\.findUnique/, "the stamp must be read inside the transaction");
  assert.match(save, /updatedAt: result\.toISOString\(\)/, "and it is the stamp THIS write produced");

  // No opt-out. An optional stamp let a caller bypass the invariant this enforces.
  assert.match(save, /expectedUpdatedAt: string,/, "the fence must be required");
  assert.doesNotMatch(save, /else \{[\s\S]{0,140}botFlow\.update\(/, "no unfenced fallback path");
});

test("the canvas carries the stamp it loaded and adopts the one it is given", () => {
  const builder = src("src/components/FlowBuilder.tsx");
  assert.match(builder, /const savedAt = useRef<string>\(updatedAt\)/);
  // Required, not optional — the page always knows what it loaded.
  assert.match(builder, /updatedAt: string \}/, "the canvas cannot be constructed without a stamp");
  assert.match(builder, /saveFlow\(flowId, JSON\.stringify\([^)]*\), savedAt\.current\)/);
  assert.match(builder, /savedAt\.current = res\.updatedAt/, "a successful save must advance the stamp");
  assert.match(builder, /res\.conflict \? "Not saved/, "and a conflict must be visible in the status");
  // The page has to hand it down, or the fence is never engaged.
  assert.match(src("src/app/(app)/bot-builder/[id]/page.tsx"), /updatedAt=\{row\.updatedAt\.toISOString\(\)\}/);
});

test("leaving with unsaved work warns instead of discarding it silently", () => {
  const builder = src("src/components/FlowBuilder.tsx");
  assert.match(builder, /addEventListener\("beforeunload"/);
  assert.match(builder, /if \(status === "Saved"\) return;/, "only warn when there is something to lose");
  assert.match(builder, /removeEventListener\("beforeunload"/, "and it must be cleaned up");
});

test("Reset is fenced too, being another draft writer", () => {
  // An unconditional Reset tramples newer work exactly as the old Save did.
  const action = src("src/app/actions/flow.ts");
  const reset = action.slice(action.indexOf("export async function resetFlow"), action.indexOf("export async function renameFlow"));
  assert.match(reset, /updatedAt: expected/, "Reset must respect the stamp the canvas loaded");
  assert.match(reset, /conflict: true/, "and report a conflict rather than overwriting");
  assert.match(src("src/components/FlowBuilder.tsx"), /resetFlow\(flowId, savedAt\.current\)/);
});
