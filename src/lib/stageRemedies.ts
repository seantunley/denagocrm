/**
 * Stage remedies: a rule with a way to satisfy it.
 *
 * PURE — types only from `stageGate.ts` and `pipelineStageActions.ts`, both of
 * which are themselves import-free — so the board can read this to decide which
 * dialog to open.
 *
 * ── WHAT A REMEDY IS ────────────────────────────────────────────────────────
 *
 * A stage RULE asks a question about facts and refuses when the answer is no. A
 * REMEDY is the offer that turns that refusal into an action: "this stage needs a
 * booked test drive — here is the booking form". So a required action is a gate
 * WITH a remedy attached, and a plain rule is the refusal half with no remedy.
 * They were two unrelated mechanisms; this is the seam that makes them one.
 *
 * ── WHY `satisfies` IS THE LOAD-BEARING FIELD ───────────────────────────────
 *
 * Each remedy DECLARES the criterion it makes true. Three things follow, and none
 * of them work if the link is left implicit:
 *
 *   1. The engine can ask "is this already true?" before offering to fix it. The
 *      old `entryAction` could not, so moving a lead into the test-drive stage
 *      opened the booking dialog even when that lead already had a booked drive.
 *   2. A stage with NO criteria of its own derives them from its remedy (see
 *      `derivedCriteria`), which is what lets this ship without a backfill.
 *   3. A rule and its remedy cannot drift into describing different things. The
 *      local cautionary tale is `marketingAudiences`, whose client re-declares
 *      the field list by hand.
 *
 * ── ADDING ONE IS STILL A BUILD ─────────────────────────────────────────────
 *
 * A remedy is a form, a transaction and a created record. This registry makes
 * adding one cheap and CONSISTENT; it does not make it free, and no amount of
 * design will. What it removes is the six places of plumbing `book_test_drive`
 * needed and every future remedy would otherwise repeat.
 */
import type { PipelineStageAction } from "./pipelineStageActions";
import type {
  StageCriteriaGroup,
  StageCriterion,
  StageGateFacts,
  StageGateMode,
  UnmetCriterion,
} from "./stageGate";

/** Which dialog the board opens. The one part that cannot be declarative. */
export type StageRemedyDialog = "test_drive" | "contact_link";

export type StageRemedy = {
  id: PipelineStageAction;
  /** Shown in the settings picker. */
  label: string;
  /** The verb on the button somebody actually clicks. */
  cta: string;
  /** One line under the settings picker, explaining what it collects. */
  description: string;
  /** THE criterion this remedy makes true. See the header. */
  satisfies: StageCriterion;
  /**
   * The facts as they WILL be once this remedy has run — its guaranteed effect,
   * applied to a snapshot taken before it.
   *
   * Required, not optional, so adding a remedy without declaring what it changes
   * is a compile error rather than a rule that quietly never notices the work.
   *
   * ── WHY A FACT EDIT AND NOT A CRITERION SUBTRACTION ─────────────────────────
   *
   * The first version of this subtracted the satisfied clause from the flattened
   * `unmet` list and re-judged what was left. That is correct only for a flat
   * `and`, because the flat list has already thrown the tree away.
   *
   * For `or(a customer is linked, a quote exists)` with neither true, linking the
   * customer satisfies the WHOLE rule — but subtraction removes the contact
   * clause, sees the quote clause still in the list, and refuses a move the rule
   * plainly permits. `not(...)` inverts the same way: a remedy can make a
   * negated group start FAILING, which subtraction can only ever loosen.
   *
   * Adjusting the facts and re-running the real evaluator keeps the whole Boolean
   * structure, because the evaluator is the thing that understands it. There is
   * then only one implementation of the rule language, which is the property this
   * module's header claims and the subtraction version quietly broke.
   */
  effect: (facts: StageGateFacts) => StageGateFacts;
  /**
   * The facts if the person makes the BEST available choice — used to decide
   * whether the dialog is worth OPENING, and for nothing else.
   *
   * `effect` is what the remedy guarantees regardless of what is chosen. That is
   * the right answer once a choice has been made, and the wrong question before
   * one has: `link_contact` guarantees only that *a* customer is attached, so a
   * stage requiring a customer AND that customer's email was refused outright and
   * the picker never opened — even though picking a customer who has an email
   * would have satisfied both. The action already projects the chosen contact's
   * real email and phone; that code was simply unreachable.
   *
   * So the offer asks "could ANY choice satisfy this?" and the action asks "does
   * THIS choice satisfy it?". Optional, and defaulting to `effect`, because a
   * remedy that collects nothing from the person — booking a test drive, raising
   * a quote — has no better case to describe.
   *
   * ⚠️ NEVER PERMITS A MOVE. This projection is optimistic by construction, so
   * using it to decide whether a write may proceed would let a lead in on the
   * strength of a customer who was never chosen. `gateStageMove` uses it for the
   * offer; every remedy action re-judges against what actually happened.
   */
  offerEffect?: (facts: StageGateFacts) => StageGateFacts;
  dialog: StageRemedyDialog;
};

export const STAGE_REMEDIES: Record<PipelineStageAction, StageRemedy> = {
  book_test_drive: {
    id: "book_test_drive",
    label: "Book a test drive",
    cta: "Book the test drive",
    description: "Require a model, date, time and location, then create a test-drive activity.",
    satisfies: { field: "activity.testDriveCount", operator: "greater_or_equal", value: 1 },
    // The booking creates ONE planned activity whose type is `test_drive`, so both
    // counters move. `plannedCount` is included because it genuinely rises — a
    // stage asking for "an activity is planned" is satisfied by booking a test
    // drive, and declaring only the narrower counter would refuse that move for a
    // fact that is about to be true.
    effect: (facts) => ({
      ...facts,
      activity: {
        ...facts.activity,
        testDriveCount: facts.activity.testDriveCount + 1,
        plannedCount: facts.activity.plannedCount + 1,
      },
    }),
    dialog: "test_drive",
  },
  link_contact: {
    id: "link_contact",
    label: "Link a customer",
    cta: "Link the customer",
    description: "Require the lead to be linked to a customer record before it may enter.",
    // The editor's Yes/No select posts "true"/"false" and `equals` compares as
    // strings, so this is the same shape a hand-written rule would take.
    satisfies: { field: "contact.linked", operator: "equals", value: "true" },
    // ONLY `linked`. The remedy guarantees that a customer is attached and nothing
    // about WHICH one, so a rule wanting the customer's email or phone is not
    // satisfied by this alone — those depend on the record the person picks, which
    // this registry cannot see. `moveLeadWithContact` layers the chosen contact's
    // own values on top, because there it IS known; that refinement belongs at the
    // call site, not here.
    effect: (facts) => ({ ...facts, contact: { ...facts.contact, linked: true } }),
    // The best the picker could do: a customer who has both an email and a phone.
    // The values are SENTINELS, not predictions — they exist so that "the customer
    // has an email" can be true in this projection, and they never reach a
    // decision that permits anything. A rule demanding an exact address is not
    // satisfied by them, which under-offers rather than over-permits.
    offerEffect: (facts) => ({
      ...facts,
      contact: {
        linked: true,
        email: facts.contact.email ?? BEST_CASE_EMAIL,
        phone: facts.contact.phone ?? BEST_CASE_PHONE,
      },
    }),
    dialog: "contact_link",
  },
};

/**
 * The facts as they will stand once this remedy has run.
 *
 * A named function rather than `remedy.effect(facts)` at each call site, so the
 * intent — "judge the rule against the world this action is about to create" —
 * reads the same everywhere it is used.
 */
export function factsAfterRemedy(facts: StageGateFacts, remedy: StageRemedy): StageGateFacts {
  return remedy.effect(facts);
}

/**
 * Stand-ins for "the chosen customer has one of these".
 *
 * Named rather than inlined so they are searchable, and shaped like real values
 * so an operator such as `contains "@"` behaves as it would against a real one.
 * They are only ever seen by `factsIfRemedyIdeal`, which decides whether to open
 * a dialog — never by anything that writes.
 */
const BEST_CASE_EMAIL = "customer@example.com";
const BEST_CASE_PHONE = "+27000000000";

/**
 * The facts if this remedy goes as well as it possibly can.
 *
 * Used ONLY to decide whether a dialog is worth offering. See `offerEffect` — the
 * projection is optimistic, so a caller that used it to permit a move would let a
 * lead in on the strength of a choice nobody made.
 */
export function factsIfRemedyIdeal(facts: StageGateFacts, remedy: StageRemedy): StageGateFacts {
  return (remedy.offerEffect ?? remedy.effect)(facts);
}

/** The remedy a stage offers, if it declares one this build understands. */
export function remedyFor(entryAction: string | null | undefined): StageRemedy | null {
  if (!entryAction) return null;
  return STAGE_REMEDIES[entryAction as PipelineStageAction] ?? null;
}

/**
 * The criteria a stage with a remedy and NO rule of its own is judged by.
 *
 * This is what keeps `book_test_drive` behaving as it always has without a
 * migration touching a single row: a stage that declares a remedy and stores no
 * criteria is treated as requiring exactly what that remedy provides, at `block`.
 * Today's behaviour therefore becomes the DERIVED case of the general one.
 *
 * Deliberately NOT written into the database. A backfill would be more honest
 * about where the behaviour comes from and is more risk on a live table; the
 * trade is recorded in docs/kanban-stage-actions.md §8.3, and this function is
 * the single place the derivation happens.
 */
export function derivedCriteria(remedy: StageRemedy): StageCriteriaGroup {
  return { logic: "and", conditions: [remedy.satisfies] };
}

/** The mode a derived gate runs at. A required action has always been mandatory. */
export const DERIVED_GATE_MODE: StageGateMode = "block";

/**
 * Does this remedy address what actually failed?
 *
 * Compared by FIELD alone. A remedy that books a test drive satisfies "a test
 * drive is booked" whether the rule asked for one or for two, and offering the
 * booking form is right in both cases — the second booking is a reschedule, and
 * the rule is re-evaluated by the server afterwards either way. Comparing the
 * operator and value as well would refuse to offer help for a rule the remedy
 * genuinely moves closer to satisfying.
 */
export function remedyAddresses(remedy: StageRemedy, unmet: UnmetCriterion[]): boolean {
  return unmet.some((criterion) => criterion.field === remedy.satisfies.field);
}
