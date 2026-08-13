# Stage actions: giving a rule a remedy

**Status:** design proposal, nothing built.
**Date:** 2026-08-13
**Baseline:** assumes PR #527 (`feat/stage-gates`) has landed — `src/lib/stageGate.ts`,
the `entryCriteria`/`exitCriteria`/`entryGateMode`/`exitGateMode` columns, the reason
dialog on `KanbanBoard.tsx`, and the gate running on all three doors into a stage
(`moveLead`, `updateLead`, `moveLeadToTestDrive`).

This exists because of a question that turned out to be the right one: *"isn't what
you built and required action on entry the same thing?"*

Nearly. And the gap between "nearly" and "yes" is this document.

---

## 0. The two halves, and why only one of them got built

The settings screen carries two controls that both describe entering a stage:

| | Required action on entry | Rules for entering |
| --- | --- | --- |
| Column | `PipelineStage.entryAction` | `PipelineStage.entryCriteria` + `entryGateMode` |
| Shipped | migration 79 | PR #527 |
| Asks | "has this workflow been done?" | "are these facts true?" |
| Can it CREATE anything | **yes** — books the drive, creates the activity | **no**, it only judges |
| When unsatisfied | opens a dialog and **fixes it inline** | refuses or warns; you go and fix it, then retry |
| Vocabulary | one hardcoded workflow | 18 fields × 11 operators |
| Extensible by a user | **no** | yes |

**A required action is a gate with a remedy attached. A rule is the refusal half with
no remedy.** That is the whole relationship, and it is worth stating plainly because
the current UI implies they are alternatives when they are two halves of one idea.

The asymmetry is real: PR #527 made the *condition* half generic and left the
*remedy* half at the single option it has had since migration 79. Nobody can add a
second one from the UI, and that is not a missing screen — each remedy is a workflow
somebody has to build.

### What `book_test_drive` actually costs today

Reading the one that exists, so the estimate for a second one is not a guess:

1. `PIPELINE_STAGE_ACTIONS = ["book_test_drive"]` — the tuple (`src/lib/pipelineStageActions.ts`);
2. `PIPELINE_STAGE_ACTION_META` — label, short label, description;
3. `CHECK ("entryAction" IS NULL OR "entryAction" IN ('book_test_drive'))` — migration 79;
4. `assertEntryActionAvailable()` — at most one stage per pipeline may hold a given action;
5. `TestDriveDialog` — a bespoke form (model, date, time, location);
6. `moveLeadToTestDrive` — a second move action that books AND moves in one transaction;
7. `KanbanBoard.requestMove` — intercepts the stage and opens the dialog instead of moving;
8. `moveLead` — the backward-move cleanup that cancels a booking when a card is dragged back;
9. `moveLead` — a flat refusal so the action cannot be skipped by the ordinary path.

Nine places. Six of them are pure plumbing that every future remedy would repeat
verbatim, and that repetition is the thing this design is arranged to remove.

---

## 1. The proposal in one paragraph

**`entryAction` stops being "a required workflow" and becomes "the remedy offered when
this stage's entry rule is unmet".** Every remedy declares, in a registry, the criterion
it satisfies. The rule engine already decides whether a lead may enter; the remedy is
what the board offers *instead of a refusal* when it cannot. `book_test_drive` keeps
working, unchanged, as the first entry in that registry.

---

## 2. Data model: no new columns

**Recommendation: reuse `entryAction`. No migration for the data itself.**

The column exists, carries the right value today, has a `CHECK` constraint that already
enumerates the vocabulary, and has the "one stage per pipeline per action" rule enforced
in `assertEntryActionAvailable`. A new `entryRemedy` column would duplicate all four and
require a backfill.

The only DDL is widening the `CHECK` as each remedy ships — one line per remedy, in that
remedy's own migration, exactly as migration 79 did.

**What changes is the meaning, not the storage:** a stage with an `entryAction` and no
`entryCriteria` behaves exactly as it does today (see §5), which is what makes this
deployable without touching a single existing row.

---

## 3. The registry

One declaration per remedy, in a **pure** module so the board can read it:

```ts
// src/lib/stageRemedies.ts — PURE. Imports types from stageGate.ts and nothing else.
export type StageRemedy = {
  id: PipelineStageAction;
  label: string;
  /** Verb on the button the person actually clicks: "Book the test drive". */
  cta: string;
  /**
   * The criterion this remedy makes true. Declared, not implied — so the engine
   * can skip the remedy when the fact is ALREADY true, and so a rule and its
   * remedy cannot drift into describing different things.
   */
  satisfies: StageCriterion;
  /** Which dialog to open. The one bespoke part. */
  dialog: "test_drive" | "quote" | "contact_link";
};

export const STAGE_REMEDIES: Record<PipelineStageAction, StageRemedy> = {
  book_test_drive: {
    id: "book_test_drive",
    label: "Book a test drive",
    cta: "Book the test drive",
    satisfies: { field: "activity.testDriveCount", operator: "greater_or_equal", value: 1 },
    dialog: "test_drive",
  },
};
```

**`satisfies` is the load-bearing field.** It is what lets the engine ask "is this
already true?" before offering to fix it, and it is what stops a remedy and its rule
describing different things — the failure `marketingAudiences` demonstrates by
re-declaring its field list by hand.

**It needs one new fact.** `activity.testDriveCount` does not exist; `activity.plannedCount`
counts every activity type, so it would report a booked service visit as a satisfied
test-drive requirement. Adding it is one line in `StageGateFacts`, one line in
`STAGE_CRITERION_FIELDS`, and one `count` in `stageGateFacts.ts` — and the existing
test that every offered field resolves against a real snapshot covers it.

---

## 4. How a move resolves, once

Today there are two independent mechanisms with two independent answers. Afterwards
there is one sequence:

```
requestMove(lead, targetStage)
  │
  ├─ 1. evaluateStageMove(...)          ← unchanged, PR #527
  │      clear? ────────────────────────────────► move
  │
  ├─ 2. does the target declare a remedy,
  │     and is the UNMET criterion the one
  │     that remedy satisfies?
  │      yes ─► open that remedy's dialog ──────► move + create, in one transaction
  │
  ├─ 3. requiresReason? ─► reason dialog ───────► move, audited as an override
  │
  └─ 4. otherwise ─────────────────────────────► refuse, with the rule's own sentence
```

Two consequences worth calling out, because both are improvements a user will notice:

- **A remedy is offered only when it is needed.** Today, moving a lead into the
  test-drive stage *always* opens the booking dialog, even when that lead already has
  a booked drive — `moveLead` refuses the stage outright and the board never asks
  whether the work is already done. Under §4 step 1, a lead whose `activity.testDriveCount`
  is already ≥ 1 moves straight in.
- **A remedy stops being a hard requirement when the rule says it is not.** A stage
  can offer "book a test drive" at `warn` — the dialog is offered, skipping it is
  allowed, and the skip is recorded. That is impossible today; `entryAction` has one
  severity, "mandatory".

---

## 5. Compatibility: the existing stage must not change behaviour

`book_test_drive` is live and Sean uses it. The rule that keeps it working:

> **A stage with an `entryAction` and NO `entryCriteria` behaves exactly as it does
> today: the dialog is mandatory.**

Implemented as a default rather than a special case — when a stage declares a remedy
but no criteria, the engine treats the remedy's own `satisfies` clause as the criteria,
at mode `block`. So today's behaviour is the *derived* case of the general one, and no
existing row needs a backfill to keep meaning what it meant.

The other compatibility points, each a real decision:

- **The backward-move cleanup stays bespoke.** `moveLead` cancels a booked test drive
  when a card is dragged back behind the test-drive stage. That is specific to bookings
  — a cancelled quote is not the same idea — so it becomes an optional `onRetreat` hook
  on the registry entry rather than something every remedy must answer.
- **`assertEntryActionAvailable` keeps its rule.** One stage per pipeline per remedy.
  Two stages both offering "attach a quote" is a pipeline configuration error, not a
  feature.
- **Closed stages still cannot carry a remedy.** Already enforced.
- **The gate runs on all three doors**, as of #527, so a remedy inherits that for free.

---

## 6. Which remedies to build — and which are free

The five candidates, with what each would cost. **The conditions are all expressible
today**; what a remedy buys is the one-click fix instead of "go and do it, then drag
the card again".

| Remedy | Criterion it satisfies | Dialog | Cost |
| --- | --- | --- | --- |
| **Book a test drive** | `activity.testDriveCount ≥ 1` | exists | **built** |
| **Link a contact** | `contact.linked is true` | a contact picker | **lowest** — the picker exists on the lead page |
| **Attach a quote** | `quote.count ≥ 1` | the quote builder, in a modal | medium — it is a big form, and it already opens as a modal elsewhere |
| **Send the quote** | `quote.sentCount ≥ 1` | reuse the existing send flow | medium |
| **Get it signed** | `signature.completedCount ≥ 1` | signing is asynchronous — see below | **highest, and probably wrong** |

**"Get it signed" is the one to refuse.** Every other remedy completes in the dialog;
signing completes *days later*, when the customer acts. A dialog that says "we have
sent it, come back when they sign" is not a remedy, it is a notification — and the deal
should sit in the stage before it, blocked by a `signature.completedCount ≥ 1` rule,
until it is true. That is what the rules half already does well.

**My recommendation for v1: "link a contact" only.** It is the cheapest possible second
entry, which is exactly what a registry needs in order to prove it is a registry rather
than a table with one row in it. Build the machinery against two remedies, ship, and let
the third be decided by whether anyone asks for it.

---

## 7. What this does NOT do

- **It does not let a user define new remedies.** A remedy is code — a form, a
  transaction, a created record. The registry makes adding one cheap and consistent;
  it does not make it free, and no amount of design will.
- **It does not merge the two settings controls into one.** They stay adjacent and
  separately labelled ("Required action on entry" / "Rules for entering X"), because
  one is a fixed list and the other is a rule builder. Once §5's derivation lands, the
  honest presentation may be a single "when a lead enters" section with the remedy as
  a property of the rule — worth revisiting after the second remedy exists, not before.
- **It does not touch exit.** No exit remedy is proposed: "you may not leave without X"
  has no natural inline fix, and the exit gate's job is to stop the move, not to do
  the work.

---

## 8. Open questions I do not have a confident answer to

1. **Should a remedy be offered when the criterion it satisfies is not the one that
   failed?** A stage requiring both a quote and a contact, missing only the contact,
   should clearly offer the contact picker. But if both are missing, offering one
   dialog and then refusing again is a two-step refusal. Offering both in sequence is
   the obvious answer and the fiddliest to build.
2. **Whether `satisfies` should be a list.** One criterion per remedy is enough for
   all five candidates above. It may not survive the sixth.
3. **Whether the derived-default in §5 is too clever.** It keeps the live stage working
   with no backfill, which is a real benefit, but it means the behaviour of a stage is
   not fully visible in its own columns — the mode is implied rather than stored. The
   alternative is a one-off migration writing the implied values into `entryCriteria`
   and `entryGateMode` for stages that carry an `entryAction`, which is more honest and
   more risk on a live table.
