import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  MAX_OPEN_RUNS_PER_ENTITY,
  REFUSAL_REASONS,
  enrolmentLockKey,
  parseRunMode,
} from "../src/lib/journeyArbitration";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * Journeys built on event triggers enrolled nobody, and the only symptom was
 * silence: an automation that never runs looks exactly like one that runs and
 * matches nobody. The engine was already recording events, runs and step logs
 * — nothing showed them, and nothing recorded WHY a journey was passed over.
 *
 * These guard the two halves of the fix: the decision is recorded, and the
 * "never fired" case is surfaced rather than left to be noticed by hand.
 */

test("every enrolment outcome is recorded, including the passed-over ones", () => {
  // The loop was bare `continue`s. A journey nobody emits for and a journey
  // whose filters did not match produced identical evidence: none.
  const code = shipped("src/lib/journeyEvents.ts");
  const start = code.indexOf("for (const journey of journeys)");
  assert.notEqual(start, -1, "the enrolment loop is gone — was it renamed?");
  // Bound the end search FROM the start: recoverStaleJourneyEvents has an
  // earlier journeyEvent.updateMany, and an unbounded indexOf finds that one,
  // slicing backwards to an empty string that passes every assertion.
  const loop = code.slice(start, code.indexOf("journeyEvent.update(", start));
  assert.ok(loop.length > 0, "the slice ran backwards");

  // Every early exit must record a verdict on its way out. A `continue` is fine
  // — a continue with no decisions.push before it is the original bug, so count
  // them: one push per skip, plus one for the enrolled case at the end.
  const skips = (loop.match(/\bcontinue;/g) ?? []).length;
  const pushes = (loop.match(/decisions\.push\(/g) ?? []).length;
  assert.ok(skips > 0, "the loop no longer skips anything — has it been rewritten?");
  assert.equal(pushes, skips + 1, `${skips} skips but ${pushes} recorded verdicts — one path exits silently`);

  for (const reason of [
    /no published version/,
    // Two of the causes moved out with the trigger LIST: "does not listen for
    // that at all" and "listens, but that trigger's filter said no" are decided
    // by decideTrigger, which returns the reason it used. The loop must carry
    // that reason through rather than flatten it — `verdict.reason`, not a
    // string of its own.
    /reason: verdict\.reason/,
    // The enrolment refusals moved into REFUSAL_REASONS, where they are one
    // string per cause rather than one string for all of them. The loop looks
    // them up instead of spelling any single one out.
    /REFUSAL_REASONS\[outcome\.refusal\]/,
  ]) {
    assert.match(loop, reason, `each distinct cause needs its own reason: ${reason}`);
  }

  // …and the two reasons it delegates are still two. Collapsing them would make
  // "this journey does not listen for that" and "it does, but not for this one"
  // the same sentence — which is the defect this whole file exists to prevent,
  // simply moved one module along.
  const triggers = shipped("src/lib/journeyTriggers.ts");
  assert.match(triggers, /listens for \$\{describeTriggers\(specs\)\}, not "\$\{eventType\}"/);
  assert.match(triggers, /reason: "trigger filters did not match"/);
  assert.match(code, /data: \{ status: "processed", processedAt: new Date\(\), decisions \}/);
});

test("the merged loop keeps BOTH the decision record and payload-aware matching", () => {
  // Two changes landed on this loop from different branches: decision tracing,
  // and judging stage_entered against the stage carried ON THE EVENT rather
  // than the lead's stage when the cron drains 15 minutes later. A merge that
  // took one side wholesale would silently drop the other — tracing that lies
  // about why nothing matched, or matching that is right but unexplained.
  const code = shipped("src/lib/journeyEvents.ts");
  const start = code.indexOf("for (const journey of journeys)");
  assert.notEqual(start, -1, "the enrolment loop is gone — was it renamed?");
  const loop = code.slice(start, code.indexOf("journeyEvent.update(", start));
  assert.ok(loop.length > 0, "the slice ran backwards");

  assert.match(loop, /decisions\.push\(/, "decision tracing must survive the merge");
  // `[^)]*` would stop at an inner call's own closing paren — match on the
  // argument tail instead, which is the part that actually carries the fix.
  assert.match(
    loop,
    /decideTrigger\([\s\S]*?context,\s*eventPayload,?\s*\)/,
    "payload-aware matching must survive the merge — without eventPayload a stage_entered event is judged against the wrong stage",
  );
});

test("every refusal keeps its own words — they are not all 'already enrolled'", () => {
  // THIS TEST USED TO ENFORCE THE BUG. It pinned
  //   reason: queued ? "enrolled" : "already enrolled for this event"
  // which is exactly the collapse that made the trace useless: enqueueJourneyRun
  // returned a bare boolean, so a missing entity, an entry-condition mismatch, a
  // definition with no steps, a per-person cap refusal, a single-mode drop and a
  // real duplicate ALL rendered as the idempotency key doing its job — that is,
  // as nothing being wrong. Someone reading the trace to find out why a customer
  // was not enrolled was told the one thing that was not true.
  const reasons = Object.values(REFUSAL_REASONS);
  assert.equal(
    new Set(reasons).size,
    reasons.length,
    "two refusals share a string — the trace cannot tell those two causes apart",
  );
  // Only the genuine duplicate may say "already enrolled".
  assert.equal(REFUSAL_REASONS.duplicate_event, "already enrolled for this event");
  for (const [refusal, text] of Object.entries(REFUSAL_REASONS)) {
    if (refusal === "duplicate_event") continue;
    assert.ok(
      !/already enrolled/.test(text),
      `"${refusal}" reads as a duplicate ("${text}") — that is the collapse this test exists to prevent`,
    );
  }
  // …and a cap refusal must name the cap, or "the trace shows when the cap
  // bites" is a claim the trace cannot support.
  assert.match(REFUSAL_REASONS.cap_reached, new RegExp(String(MAX_OPEN_RUNS_PER_ENTITY)));
});

test("the trace answers 'has this trigger EVER fired'", () => {
  // The question a run list cannot answer: an empty list looks the same whether
  // the trigger is broken or the workspace is quiet.
  const trace = shipped("src/lib/journeyTrace.ts");
  assert.match(trace, /everSeen/, "the never-fired case must be distinguishable from a quiet one");
  assert.match(trace, /journeyEvent\.groupBy/);
  assert.match(trace, /JOURNEY_TRIGGERS\.map/, "every trigger the builder OFFERS must be listed, not only those seen");
});

test("the page leads with the broken-wiring case", () => {
  const page = shipped("src/app/(app)/journeys/activity/page.tsx");
  assert.match(page, /const neverFired = health\.filter\(\(row\) => !row\.everSeen\)/);
  assert.match(page, /never fired/i, "…and says so in words, not just a count");
  // The trace exposes entity ids, so it must be gated — on journeys.manage, the
  // same permission the sidebar shows the link on. It demanded requireOwner()
  // while the nav advertised the permission, so a delegated user clicked
  // "Journeys" and was redirected to "/".
  assert.match(page, /requireRoute\("\/journeys"\)/, "the trace exposes entity ids and must be gated");
});

test("an event predating tracing is not reported as 'nothing considered'", () => {
  // decisions is nullable by design. Rendering NULL as an empty list would
  // accuse every historic event of having matched nothing.
  const trace = shipped("src/lib/journeyTrace.ts");
  assert.match(trace, /if \(!Array\.isArray\(value\)\) return null;/);
  const page = shipped("src/app/(app)/journeys/activity/page.tsx");
  assert.match(page, /event\.decisions === null/, "null and empty must render differently");
  assert.match(page, /event\.decisions\.length === 0/);
});

test("the trace is reachable from the journeys screen", () => {
  // A diagnostic nobody can find is a diagnostic nobody uses.
  assert.match(shipped("src/app/(app)/journeys/page.tsx"), /href="\/journeys\/activity"/);
});
