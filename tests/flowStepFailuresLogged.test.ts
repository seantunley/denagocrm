import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runFlow, stepFailuresToLog, type ActionOutcome, type Flow, type FlowCtx } from "../src/lib/flow";

type Seen = { action: string; ok: boolean; reason?: string; routine?: boolean };

/** Runs one knowledge or extract step with the given outcome; returns what the runners would send to the System Log. */
async function logged(type: "knowledge" | "extract", outcome: ActionOutcome): Promise<Seen[]> {
  const seen: Seen[] = [];
  const step = type === "knowledge"
    ? { id: "s", type: "knowledge" as const, query: "warranty", saveAs: "answer", next: "end", failureNext: "end" }
    : { id: "s", type: "extract" as const, instruction: "extract", fields: ["city"], next: "end", failureNext: "end" };
  const flow = { start: "s", nodes: { s: step, end: { id: "end", type: "end" } } } as Flow;
  const ctx = {
    knowledgeAnswer: async () => outcome,
    extractData: async () => outcome,
    recordAction: (_nodeId: string, action: string, ok: boolean, reason?: string, routine?: boolean) => seen.push({ action, ok, reason, routine }),
  } as unknown as FlowCtx;
  await runFlow(flow, { nodeId: null, vars: {} }, { text: "Cape Town" }, ctx);
  return stepFailuresToLog(seen);
}

test("a setup or provider failure in an FAQ or AI-reading step reaches the System Log", async () => {
  // The reasons lib/flowRuntimeTools returns for real faults — none of them marked `unavailable`.
  for (const reason of ["AI extraction is not configured", "No extraction fields were configured", "AI extraction returned invalid structured data", "AI extraction provider returned 529"]) {
    assert.deepEqual((await logged("extract", { ok: false, reason })).map((s) => s.reason), [reason]);
  }
  assert.equal((await logged("knowledge", { ok: false, reason: "Knowledge search unavailable" })).length, 1);
});

test("a routine miss — nothing matched, nothing to read — is not logged", async () => {
  assert.deepEqual(await logged("knowledge", { ok: false, unavailable: true, reason: "No approved knowledge matched" }), []);
  assert.deepEqual(await logged("extract", { ok: false, unavailable: true, reason: "No requested values were present" }), []);
  assert.deepEqual(await logged("extract", { ok: true }), []);
});

test("other failed steps are logged; successes are not", () => {
  const out = stepFailuresToLog([
    { action: "crm_tag", ok: false, reason: "No customer record to tag" },
    { action: "booking_service", ok: false },
    { action: "journey_start", ok: true },
  ]).map((a) => a.action);
  assert.deepEqual(out, ["crm_tag", "booking_service"]);
});

test("both runners log a turn's failed steps; a superseded timeout's refused steps are not logged", () => {
  const run = readFileSync("src/lib/flowRun.ts", "utf8");
  assert.match(run, /if \(fence\?\.superseded\(\)\) return true;\r?\n\s*await logFailedSteps\(/, "logged only after the supersede check");
  assert.match(readFileSync("src/lib/flowSession.ts", "utf8"), /await runFlow\([^\n]*\r?\n\s*await logFailedSteps\(/);
});
