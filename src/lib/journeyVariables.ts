import { AbortJourney } from "./journeyControlFlow";
import { JOURNEY_LIMITS, type JourneyVariableAssignment } from "./journeyTypes";
import { renderTemplate } from "./template";

/**
 * `variables`: named values set into the run context for later steps to read.
 *
 * ── The decision: NAMESPACED under `vars`, not bare keys with a reject-list ──
 *
 * The brief for this was "names must not be able to shadow the engine's own
 * context keys (`contact`, `lead`, `event`, `repeat`, …)". Two ways to get
 * there, and the reject-list is the wrong one — see VARIABLE_FIELD in
 * journeyTypes.ts for the argument in full. The short version: that list is a
 * moving target (`repeat` became a context key two commits ago), a published
 * version is immutable, and so a name that is legal today becomes a silent
 * mis-read the day the engine grows a key with the same spelling. Namespacing
 * makes the collision impossible rather than currently-absent.
 *
 * The bag therefore lives at `context.vars`, a FLAT map of string → string:
 *
 *   conditions   `vars.<name>`  — the one namespace CONDITION_FIELDS admits
 *   templates    `{{var_<name>}}` — flat, because renderTemplate's `\w` token
 *                                   cannot match a dot (see template.ts)
 *
 * ── Why the size cap is enforced at RUN time ────────────────────────────────
 *
 * The parser bounds the count and each template's source length, which is the
 * cheap half. The half that matters is the RENDERED total, and only the run
 * knows that: `processOneRun` writes the whole context back as JSON after every
 * single step, so the bag is paid for on every write for the remaining life of
 * a run that may last weeks. A journey that loops a `variables` step inside a
 * `repeat`, appending each time, is the shape that gets there.
 */

/** Where the bag lives. Not configurable — conditions name it literally. */
export const JOURNEY_VARS_KEY = "vars";

/** The bag on a context, defensively: a hand-edited run must not crash a tick. */
export function journeyVars(context: Record<string, unknown>): Record<string, string> {
  const raw = context[JOURNEY_VARS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

/**
 * Re-attach the bag to a freshly loaded context.
 *
 * `loadJourneyContext` returns `{ event, lead, contact }` and nothing else, and
 * the runner replaces the whole context with it after every step. Without this
 * every variable would be erased by the very next step — which is precisely the
 * trap `repeat` variables avoid by being derived from the cursor instead of
 * stored. Variables cannot be derived: they are authored values, so they have to
 * survive the refresh explicitly.
 *
 * Omits the key entirely when the bag is empty, so a journey with no `variables`
 * step writes byte-for-byte the context it always did.
 */
export function withJourneyVars<T extends Record<string, unknown>>(
  context: T,
  vars: Record<string, string>,
): T {
  if (Object.keys(vars).length === 0) return context;
  return { ...context, [JOURNEY_VARS_KEY]: vars };
}

export type AppliedVariables = {
  /** The whole bag after this step — earlier variables are kept, not replaced. */
  vars: Record<string, string>;
  /** Names whose rendered value hit the per-value cap. Reported, never silent. */
  truncated: string[];
};

/**
 * Render a `variables` step and merge it over the bag the run already has.
 *
 * `templateVars` is passed in rather than derived, because deriving it means
 * `journeyContext.ts`, which means Prisma — and this decision has to stay
 * importable without a database, the same split journeyStepControl.ts makes.
 *
 * Re-setting an existing name OVERWRITES it. That is the point of the step
 * inside a loop, and it is also why the total is re-checked every time rather
 * than accumulated: overwriting can shrink the bag as easily as grow it.
 */
export function applyJourneyVariables(args: {
  stepId: string;
  assignments: JourneyVariableAssignment[];
  existing: Record<string, string>;
  templateVars: Record<string, string>;
}): AppliedVariables {
  const { stepId, assignments, existing, templateVars } = args;
  const vars: Record<string, string> = { ...existing };
  const truncated: string[] = [];

  for (const { name, template } of assignments) {
    const rendered = renderTemplate(template, templateVars);
    if (rendered.length > JOURNEY_LIMITS.variableChars) truncated.push(name);
    vars[name] = rendered.slice(0, JOURNEY_LIMITS.variableChars);
  }

  // The bag is what gets persisted, so measure the thing that gets persisted.
  const size = JSON.stringify(vars).length;
  if (size > JOURNEY_LIMITS.variableBytes) {
    // AbortJourney, not a plain Error: rendering the same templates against the
    // same record produces the same size next time, so the three retries an
    // ordinary fault buys would fail three times and spend the budget doing it.
    throw new AbortJourney(
      `Variables ${stepId} would store ${size} bytes of run context, over the ${JOURNEY_LIMITS.variableBytes} byte limit`,
    );
  }
  return { vars, truncated };
}

/** `{{var_<name>}}` keys for renderTemplate. See template.ts for the dot rule. */
export function variableTemplateVars(vars: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(vars).map(([name, value]) => [`var_${name}`, value]));
}
