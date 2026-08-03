import type { JourneyRunMode } from "./journeyArbitration";

/**
 * The four run modes, said to an operator.
 *
 * Separate file from journeyArbitration.ts on purpose: that module imports
 * `basePrisma`, and the builder that has to offer these is a client component.
 * A value import from there would pull the Prisma client into the browser
 * bundle. `JourneyRunMode` crosses as `import type`, which is erased.
 *
 * The wording tracks the doc comment on `Journey.runMode` in
 * prisma/journeys.prisma — that comment is the definition, this is the same
 * thing in the second person. A bare `single | restart | queued | parallel`
 * dropdown is not a control surface: the modes differ only in what happens to
 * the run already in flight, and that is exactly what the four words hide.
 */
export type JourneyRunModeCopy = {
  value: JourneyRunMode;
  label: string;
  /** One line, and it must say what becomes of the run already in flight. */
  description: string;
};

/**
 * Typed as a full Record, so adding a mode to the union is a compile error here
 * until it has been given wording — a mode that reaches the dropdown unexplained
 * is the defect this file exists to prevent.
 */
export const JOURNEY_RUN_MODE_COPY: Record<JourneyRunMode, JourneyRunModeCopy> = {
  single: {
    value: "single",
    label: "Single",
    description: "The run already going wins — a second enrolment is dropped while it is still open.",
  },
  restart: {
    value: "restart",
    label: "Restart",
    description: "The run already going is cancelled, and the new enrolment replaces it from step one.",
  },
  queued: {
    value: "queued",
    label: "Queued",
    description: "The new enrolment waits, and starts only once the run already going has finished.",
  },
  parallel: {
    value: "parallel",
    label: "Parallel",
    description: "Both runs continue side by side, and both of them send.",
  },
};

/** Presentation order: safest first, and the one that sends twice last. */
export const JOURNEY_RUN_MODES: readonly JourneyRunModeCopy[] = [
  JOURNEY_RUN_MODE_COPY.single,
  JOURNEY_RUN_MODE_COPY.restart,
  JOURNEY_RUN_MODE_COPY.queued,
  JOURNEY_RUN_MODE_COPY.parallel,
];

/**
 * Journeys that existed before run modes did were backfilled to `parallel`,
 * while new ones default to `single`. The divergence is deliberate — backfilling
 * to `single` would have quietly changed live behaviour — but it means an old
 * journey and a new one can sit side by side on the same list doing opposite
 * things, so the screen has to say so rather than let the operator assume.
 */
export const RUN_MODE_LEGACY_NOTE =
  "Journeys created before run modes existed were left on “parallel”, which is what they had always done. New journeys start on “single”. Nothing changes this but the control above.";
