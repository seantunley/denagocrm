import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parseRunMode } from "../src/lib/journeyArbitration";
import { JOURNEY_RUN_MODES, JOURNEY_RUN_MODE_COPY } from "../src/lib/journeyRunModes";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** A slice that never runs backwards, and never silently matches nothing. */
function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  assert.notEqual(start, -1, `anchor not found: ${from}`);
  const end = text.indexOf(to, start);
  assert.notEqual(end, -1, `closing anchor not found after ${from}: ${to}`);
  const slice = text.slice(start, end);
  assert.ok(slice.length > 0, "the slice ran backwards");
  return slice;
}

/**
 * The control surface for run modes and the manual test run.
 *
 * The engine half of both shipped without a way to reach it: `runMode` existed
 * only in journeyArbitration.ts and journeyEngineShared.ts, so every journey was
 * pinned to whatever the database held — the backfilled ones permanently
 * `parallel`, new ones permanently `single` — and `runJourneyOnLead` had no
 * caller at all. These guards are about the wiring staying attached.
 */

/* ── runMode reaches the database and comes back ─────────────────────────── */

test("saving a draft writes the chosen run mode to the journey row", () => {
  // THE ROUND TRIP. The mode lives on Journey, not JourneyVersion, and the save
  // action rewrote Journey without it — so the editor could offer the control,
  // the form could carry it, and the value would still be thrown away on the
  // way past. Nothing in the UI would look broken.
  const actions = shipped("src/app/actions/journeys.ts");
  const save = between(actions, "export async function saveJourneyDraft", "export async function publishJourney");
  const journeyUpdate = between(save, "tx.journey.update", "});");
  assert.match(journeyUpdate, /data\.runMode/, "saveJourneyDraft must write the run mode");
});

test("creating a journey persists the mode the operator picked", () => {
  // Otherwise every new journey is `single` whatever the form said, which is
  // the same defect one screen earlier.
  const actions = shipped("src/app/actions/journeys.ts");
  const create = between(actions, "export async function createJourney", "export async function saveJourneyDraft");
  const journeyCreate = between(create, "tx.journey.create", "await tx.journeyVersion.create");
  assert.match(journeyCreate, /data\.runMode/, "createJourney must persist the run mode");
});

test("a form that omits runMode leaves the stored mode alone", () => {
  // parseRunMode maps anything unrecognised to "single" — correct for a garbage
  // value, destructive for an absent one. Reading a missing field through it
  // would silently downgrade every backfilled `parallel` journey to `single` the
  // first time anyone pressed Save, and `parallel` journeys are exactly the ones
  // whose behaviour was preserved on purpose.
  const actions = shipped("src/app/actions/journeys.ts");
  const parse = between(actions, "function journeyData(formData: FormData)", "export async function createJourney");
  assert.match(
    parse,
    /formData\.get\("runMode"\)[\s\S]*?===\s*null\s*\?\s*null\s*:\s*parseRunMode\(/,
    "absent must be distinguished from invalid before parseRunMode sees it",
  );
  // …and both writers must honour that null rather than defaulting over it.
  assert.equal(
    (actions.match(/\.\.\.\(data\.runMode \? \{ runMode: data\.runMode \} : \{\}\)/g) ?? []).length,
    2,
    "create and save must both write the mode only when the form carried one",
  );
});

test("the actions validate with parseRunMode instead of their own string check", () => {
  // A second copy of the allowed set drifts from the first. The engine reads
  // `runMode` through parseRunMode, so anything the writer admits that the
  // reader does not becomes a journey that silently runs as `single`.
  const actions = shipped("src/app/actions/journeys.ts");
  assert.match(actions, /import \{ parseRunMode \} from "@\/lib\/journeyArbitration"/);
  for (const mode of ["restart", "queued", "parallel"]) {
    assert.ok(
      !new RegExp(`"${mode}"`).test(actions),
      `journeys.ts names "${mode}" itself — the allowed set belongs to parseRunMode`,
    );
  }
});

/* ── every mode is explained, in words ───────────────────────────────────── */

test("all four modes carry a line of plain English, and they are real modes", () => {
  // A dropdown reading single | restart | queued | parallel is not a control
  // surface: the modes differ only in what happens to the run already in
  // flight, and those four words say nothing about that.
  assert.equal(JOURNEY_RUN_MODES.length, 4, "all four modes must be offered");
  for (const mode of JOURNEY_RUN_MODES) {
    assert.equal(
      parseRunMode(mode.value),
      mode.value,
      `${mode.value} is not a mode the engine recognises`,
    );
    assert.equal(JOURNEY_RUN_MODE_COPY[mode.value], mode, "the list and the record must agree");
    assert.ok(mode.label.trim().length > 0, `${mode.value} has no label`);
    assert.ok(
      mode.description.trim().split(/\s+/).length >= 8,
      `${mode.value}'s explanation is too short to explain anything: ${mode.description}`,
    );
  }
  const descriptions = new Set(JOURNEY_RUN_MODES.map((mode) => mode.description));
  assert.equal(descriptions.size, 4, "two modes share an explanation, so one of them is wrong");
});

test("the run-mode copy stays importable from the browser", () => {
  // journeyArbitration.ts imports basePrisma. A value import from there into the
  // copy module would drag the Prisma client into the bundle of every client
  // component that renders the control — the reason this file exists at all.
  const copy = shipped("src/lib/journeyRunModes.ts");
  assert.match(copy, /^import type \{ JourneyRunMode \} from "\.\/journeyArbitration";/m);
  assert.ok(
    !/^import \{/m.test(copy),
    "only type imports may cross from journeyArbitration into client-reachable code",
  );
});

/* ── the builder offers it, the list shows it ────────────────────────────── */

test("the builder renders a runMode control seeded from the journey's own row", () => {
  // Seeding from a constant is how an old `parallel` journey would show as
  // `single` in its own editor — and then become `single` on the next save.
  const builder = shipped("src/components/JourneyBuilder.tsx");
  assert.match(builder, /useState\(defaults\.runMode \?\? "single"\)/, "the control must start from the row");
  assert.match(builder, /name="runMode"/, "the form has to carry the field");
  assert.match(builder, /JOURNEY_RUN_MODES\.map\(/, "every mode is offered, not a hand-picked subset");
  assert.match(builder, /\{mode\.description\}/, "…and each one renders its explanation");
  assert.match(builder, /RUN_MODE_LEGACY_NOTE/, "the single/parallel divergence must be stated, not hidden");
});

test("the journeys list shows the current mode without opening the editor", () => {
  // Existing journeys were backfilled to `parallel` and new ones default to
  // `single`, so two rows on this list do opposite things on a second enrolment
  // and nothing else on the card says which.
  const page = shipped("src/app/(app)/journeys/page.tsx");
  assert.match(page, /JOURNEY_RUN_MODE_COPY\[parseRunMode\(journey\.runMode\)\]/, "read the row, through the parser");
  assert.match(page, /\{runMode\.value\}/, "the mode itself must appear on the card");
  assert.match(page, /\{runMode\.description\}/, "…with the line that says what it means");
  const defaults = between(page, "function defaultsFor", "function triggerLabel");
  assert.match(defaults, /runMode: parseRunMode\(journey\.runMode\)/, "the editor must be seeded from the row");
});

/* ── the manual test run has a caller, and tells the truth ───────────────── */

test("runJourneyOnLead is actually reachable from the UI", () => {
  // It shipped with no caller. A tested-nowhere test button is the defect.
  const component = shipped("src/components/JourneyTestRun.tsx");
  assert.match(component, /import \{ runJourneyOnLead \} from "@\/app\/actions\/journeyRuns"/);
  assert.match(component, /runJourneyOnLead\(journeyId, leadId\)/, "called with the action's own signature");
  const page = shipped("src/app/(app)/journeys/page.tsx");
  assert.match(page, /<JourneyTestRun\b/, "and the journey list has to render it");
});

test("the operator is told it really sends BEFORE they can commit", () => {
  // Not a dry run, on purpose: the half of a journey that breaks is the message,
  // the merge fields and the consent gate, and only a real send exercises those.
  // So the warning belongs in front of the button, not in a tooltip after it.
  // Comments are stripped first — a doc comment explaining the danger is not a
  // warning the operator can read.
  const component = shipped("src/components/JourneyTestRun.tsx");
  const warning = component.indexOf("This is not a dry run.");
  const named = component.indexOf("will really be contacted");
  const commit = component.indexOf("Run it for real");
  assert.notEqual(warning, -1, "the dialog must say the run is real");
  assert.notEqual(named, -1, "…and name the lead that is about to receive it");
  assert.notEqual(commit, -1, "the confirm button is gone");
  assert.ok(warning < commit, "the warning must precede the button that commits");
  assert.ok(named < commit, "the per-lead warning must precede the button that commits");
});

test("a refusal is rendered in full, not flattened into a toast", () => {
  // "Not enrolled: entry conditions did not match" is the single most useful
  // sentence this screen can produce. A generic "Something went wrong" throws it
  // away, and the operator is back to guessing — which is the failure the whole
  // journey trace effort exists to stop.
  const component = shipped("src/components/JourneyTestRun.tsx");
  // Bounded to the refusal banner itself. Asserting {result.error} anywhere in
  // the file would be satisfied by the "Last error" line on a SUCCESSFUL run —
  // a different branch entirely, and the refusal could still say "Something
  // went wrong" with the guard green.
  const refusal = between(component, 'title="Nothing was sent"', "</FeedbackBanner>");
  assert.match(refusal, /\{result\.error\}/, "the refusal reason must reach the screen verbatim");
  assert.match(component, /result\.status/, "and the final run status is the point of a test run");
  assert.match(component, /result\.runId/, "…with the run to look up in the activity trace");
  assert.ok(
    !/\btoast\b/.test(component),
    "a toast cannot hold a refusal reason and disappears before it is read",
  );
  // The dialog must survive the answer, or the answer is unreadable.
  assert.ok(
    !/setOpen\(false\)/.test(component),
    "closing the dialog on completion discards the result it was opened to get",
  );
});

test("the result shape is pinned to the action, not retyped beside it", () => {
  // A hand-written mirror of { ok, runId, status, error } drifts, and the drift
  // shows up as a blank panel rather than a type error.
  const component = shipped("src/components/JourneyTestRun.tsx");
  assert.match(
    component,
    /Awaited<ReturnType<typeof runJourneyOnLead>>/,
    "derive the result type from the action so a change to it breaks the build",
  );
});
