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

/** Model the `updateMany({ where: { id, updatedAt } })` fence the server applies. */
function fencedSave(row: { updatedAt: string }, expectedUpdatedAt: string | undefined): "written" | "refused" {
  if (!expectedUpdatedAt) return "written"; // unfenced legacy path
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

test("the server fences the write and reports the conflict rather than swallowing it", () => {
  const action = src("src/app/actions/flow.ts");
  const save = action.slice(action.indexOf("export async function saveFlow"), action.indexOf("export async function resetFlow"));
  assert.match(save, /updateMany\(\{ where: \{ id, updatedAt: expected \}/, "the save must be fenced");
  assert.match(save, /written\.count !== 1/, "and must notice when it did not land");
  assert.match(save, /conflict: true/, "the caller needs to know it was a conflict, not a generic failure");
  // Losing work silently is the defect; the refusal has to be explained.
  assert.match(save, /changed somewhere else after you opened it/);
  // And the next save from this tab must fence against the NEW stamp.
  assert.match(save, /updatedAt: saved\?\.updatedAt\.toISOString\(\)/);
});

test("the canvas carries the stamp it loaded and adopts the one it is given", () => {
  const builder = src("src/components/FlowBuilder.tsx");
  assert.match(builder, /const savedAt = useRef\(updatedAt\)/);
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
