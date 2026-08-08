import {
  JOURNEY_LIMITS,
  JOURNEY_SCHEDULED_TRIGGERS,
  JOURNEY_TRIGGERS,
  type JourneyTrigger,
} from "./journeyTypes";

/**
 * WHAT ENROLS SOMEONE INTO A JOURNEY — a LIST, not a single name.
 *
 * A published version used to listen for exactly one event type, held in
 * `JourneyVersion.trigger`, qualified by one `JourneyVersion.triggerConfig`.
 * "Enrol when a lead is created OR when one is imported" was therefore two
 * identical journeys, maintained side by side, drifting apart the first time
 * somebody edited one of them.
 *
 * Both columns are replaced by `JourneyVersion.triggers`, one JSON array:
 *
 *     [{ "id": "quoted", "type": "stage_entered", "config": { "stageId": "…" } },
 *      { "id": "won",    "type": "stage_entered", "config": { "stageId": "…" } }]
 *
 * ── Why JSON and not a child table ──────────────────────────────────────────
 *
 * A published version is IMMUTABLE. Nothing ever updates one row of this list
 * after publish, so there is no independent lifetime for a child row to have —
 * the list is part of the version document, exactly as `definition`,
 * `entryConditions` and the old `triggerConfig` already were.
 *
 * And the matcher does not query by trigger. `processOneEvent` loads the active
 * journeys once per event — a set bounded by "journeys someone switched on",
 * not by table size — and compares in memory. A child table would add a join to
 * every one of those reads, a second write inside the publish transaction, and
 * a fourth journey table needing its own tenant column, RLS policy and cascade
 * rules, to make a filter faster that is not a filter.
 *
 * ── Why config is PER trigger ───────────────────────────────────────────────
 *
 * Every key the old shared `triggerConfig` held qualifies exactly one trigger
 * type: `stageId` for stage_entered, `idleDays` for lead_idle, `segmentId` for
 * contact_segment, `inactiveMonths` for win_back. Shared, the very first thing
 * a person wants — "entered Quoted OR entered Won" — is inexpressible, because
 * one bag cannot hold two stageIds. So each trigger carries its own.
 *
 * ── Why an author-given `id`, on top of `event.type` ────────────────────────
 *
 * `event.type` is already a condition field, and for triggers of different types
 * it answers "which one fired" on its own. Two triggers of the SAME type are
 * what it cannot separate, and per-trigger config is precisely what makes that
 * pair worth having. The id is optional for that reason: it earns its keep only
 * where the type does not, and it is REQUIRED there (see parseJourneyTriggers).
 */
export type JourneyTriggerSpec = {
  /** Author's own name for this trigger. Published as `event.triggerId`. */
  id?: string;
  /**
   * Deliberately `string`, not `JourneyTrigger`, even though the save path only
   * ever writes a known one.
   *
   * The retirement of the previous automations engine converted every rule it
   * could not translate into an UNPUBLISHED draft that keeps the rule's original
   * trigger string — a name this engine has never had. Those rows are never
   * executed, but they are opened in the builder and listed on screen, and a
   * reader that narrowed the type would have to either throw on them or silently
   * rewrite them. An unknown name simply matches no event, which is exactly what
   * the single-trigger comparison did.
   */
  type: string;
  config: Record<string, unknown>;
};

/** What each trigger is CALLED on screen — one copy, read by builder and list. */
export const JOURNEY_TRIGGER_LABELS: Record<JourneyTrigger, string> = {
  lead_created: "New lead created",
  stage_entered: "Lead enters a stage",
  lead_won: "Lead is won",
  lead_lost: "Lead is lost",
  quote_signed: "Quote is signed",
  quote_declined: "Quote is declined",
  delivered: "Vehicle delivered",
  referral_earned: "Referral is earned",
  lead_idle: "Lead becomes idle",
  contact_segment: "Contact joins a saved segment",
  purchase_anniversary: "Purchase anniversary",
  win_back: "Inactive customer win-back",
};

const TRIGGER_TYPES = new Set<string>(JOURNEY_TRIGGERS);
const SCHEDULED_TYPES = new Set<string>(JOURNEY_SCHEDULED_TRIGGERS);

/** Does the cron enrol for this trigger by sweeping records, rather than an event? */
export const isScheduledTrigger = (type: string) => SCHEDULED_TYPES.has(type);

/**
 * Trigger types that carry NO filter capable of telling two instances apart.
 *
 * Listing a type here means "at most one per version". Absent types have a
 * discriminating config — stageId, segmentId, idleDays, inactiveMonths — so two
 * of those describe genuinely different enrolments and both are reachable.
 */
const FILTERLESS_TRIGGER_TYPES = [
  "lead_created",
  "lead_won",
  "lead_lost",
  "quote_signed",
  "quote_declined",
  "delivered",
  "referral_earned",
] as const;

/** Same shape a step id must have — safe in a dedupe key and in a condition value. */
const TRIGGER_ID = /^[a-zA-Z0-9_-]{1,40}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * VALIDATE an authored trigger list. Throws, and is used by save and publish —
 * the only places a person is waiting to be told their journey is wrong.
 *
 * Two rules are worth stating because neither is tidiness:
 *
 *  - Ids are UNIQUE. `event.triggerId` is how a later step branches on which
 *    trigger fired; two triggers sharing a name make that condition ambiguous
 *    rather than wrong, which is the harder kind of bug to see.
 *  - Two triggers of the SAME TYPE must each be named. Unnamed, they are
 *    indistinguishable to `event.triggerId`, indistinguishable in the trace, and
 *    — the one that silently loses work — indistinguishable in the scheduler's
 *    dedupe key, where the second one's enrolments would collide with the
 *    first's and simply never be emitted.
 */
export function parseJourneyTriggers(value: unknown): JourneyTriggerSpec[] {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  if (list.length === 0) throw new Error("A journey needs at least one enrolment trigger");
  if (list.length > JOURNEY_LIMITS.triggers) {
    throw new Error(`A journey may listen for at most ${JOURNEY_LIMITS.triggers} triggers`);
  }

  const specs = list.map((raw) => {
    // A bare string is accepted so a caller holding the old single-trigger shape
    // — a template, a fixture, an import — does not have to restate it as an
    // object to say the same thing.
    const entry: Record<string, unknown> = typeof raw === "string" ? { type: raw } : isRecord(raw) ? raw : {};
    const type = String(entry.type ?? "");
    if (!TRIGGER_TYPES.has(type)) throw new Error(`Unsupported journey trigger: ${type || "(none)"}`);

    const spec: JourneyTriggerSpec = { type, config: isRecord(entry.config) ? entry.config : {} };
    const id = entry.id == null || entry.id === "" ? null : String(entry.id).trim();
    if (id !== null) {
      if (!TRIGGER_ID.test(id)) throw new Error(`Unsafe trigger ID: ${id}`);
      spec.id = id;
    }
    return spec;
  });

  const ids = specs.map((spec) => spec.id).filter((id): id is string => Boolean(id));
  if (new Set(ids).size !== ids.length) {
    throw new Error("Two triggers share an ID — a step branching on event.triggerId could not tell them apart");
  }
  for (const spec of specs) {
    if (specs.filter((other) => other.type === spec.type).length > 1 && !spec.id) {
      throw new Error(
        `This journey lists "${spec.type}" more than once, so each one needs its own ID — otherwise nothing can tell them apart`,
      );
    }
  }

  // UNIQUE IDS ARE NOT ENOUGH WHEN NOTHING CAN SELECT BETWEEN THEM.
  //
  // A distinct id makes two same-type triggers distinguishable to a person
  // reading the journey. It does not make them REACHABLE. Emitters broadcast an
  // event TYPE — `lead_created` — and cannot know a version-specific trigger id,
  // so matching falls to the first entry of that type and every later one is
  // dead config: it renders in the builder, it reads as configured, and it never
  // fires. Accepting it is worse than rejecting it, because the failure is
  // invisible.
  //
  // The types below carry no filter capable of separating two instances. The
  // ones deliberately ABSENT do: stage_entered has stageId, segment_entered has
  // segmentId, lead_idle has idleDays, win_back has inactiveMonths — two of
  // those differ by their config and both are genuinely reachable.
  for (const type of FILTERLESS_TRIGGER_TYPES) {
    if (specs.filter((spec) => spec.type === type).length > 1) {
      throw new Error(
        `This journey lists "${type}" more than once, but nothing distinguishes them — an event carries only its type, so only the first would ever fire. Remove the duplicate, or use a trigger that filters (a stage, a segment, or an idle period).`,
      );
    }
  }
  return specs;
}

/**
 * READ a stored trigger list. NEVER throws, and is what the engine uses.
 *
 * The distinction from parseJourneyTriggers is the whole point. A stored row is
 * not authored input: it may predate a rule, or carry a trigger name from the
 * automations engine that was retired into it. One such row must not be able to
 * throw inside `processOneEvent`, because that call sits in the loop that
 * decides enrolment for EVERY OTHER active journey on the same event — a single
 * unreadable version would fail the event, retry it twice, and then strand it,
 * taking every unrelated journey's enrolment with it.
 *
 * So this coerces rather than rejects, and never invents: a name it does not
 * recognise is kept verbatim and matches no event, which is exactly what the
 * single-trigger string comparison did with the same value.
 */
export function readJourneyTriggers(value: unknown): JourneyTriggerSpec[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const entry: Record<string, unknown> = typeof raw === "string" ? { type: raw } : isRecord(raw) ? raw : {};
    const type = typeof entry.type === "string" ? entry.type : "";
    if (!type) return [];
    const spec: JourneyTriggerSpec = { type, config: isRecord(entry.config) ? entry.config : {} };
    if (typeof entry.id === "string" && entry.id) spec.id = entry.id;
    return [spec];
  });
}

/**
 * What a scheduled sweep appends to its dedupe key so two triggers of the SAME
 * TYPE on one version do not collide.
 *
 * EMPTY for an unnamed trigger, and that is the whole reason this is a function
 * rather than a template inline in the scheduler. Every version backfilled from
 * the single-trigger column has exactly one unnamed trigger, so its keys stay
 * byte-identical to the ones already recorded — a journey mid-anniversary-cycle
 * does not re-emit to everybody it has already contacted the first time this
 * deploys. Change this to always append something and that is precisely what
 * happens.
 *
 * A version listing one type twice cannot leave them unnamed: parseJourneyTriggers
 * refuses it, so the suffix is always there where it is actually needed.
 */
export const triggerKeySuffix = (spec: JourneyTriggerSpec) => (spec.id ? `:${spec.id}` : "");

/** `"lead_created" or "stage_entered"` — for the decision recorded on an event. */
export function describeTriggers(specs: JourneyTriggerSpec[]): string {
  if (specs.length === 0) return "nothing";
  return specs.map((spec) => `"${spec.type}"`).join(" or ");
}

/**
 * Does this ONE trigger's own filter admit this event?
 *
 * Unchanged in substance from the single-trigger version, including the reason
 * `payload` is consulted first: events are drained by a cron every 15 minutes,
 * so a rep who moves a lead Qualified → Quoted inside that window would have the
 * Qualified event judged against "Quoted" and silently match nothing. The stage
 * recorded ON THE EVENT is the one that fired it.
 */
export function triggerMatches(
  spec: JourneyTriggerSpec,
  context: { lead?: Record<string, unknown> | null } | null,
  payload: Record<string, unknown> = {},
): boolean {
  if (!context) return false;
  if (spec.type === "stage_entered") {
    const lead = (context.lead ?? {}) as Record<string, unknown>;
    const entered = typeof payload.stageId === "string" ? payload.stageId : lead.stageId;
    return !spec.config.stageId || spec.config.stageId === entered;
  }
  return true;
}

/**
 * One version's verdict on one event: which trigger let it in, or why none did.
 *
 * Pure, and separate from the database loop that calls it, so the three cases a
 * reader actually cares about can be exercised directly. They must stay three
 * distinct outcomes: "this journey does not listen for that at all", "it does,
 * but the trigger's own filter said no", and "it does — this trigger". The first
 * two used to be one `continue` each, and telling them apart is the entire
 * reason enrolment decisions are recorded on the event.
 */
export type TriggerVerdict =
  | { matched: null; reason: string }
  | { matched: JourneyTriggerSpec };

export function decideTrigger(
  specs: JourneyTriggerSpec[],
  eventType: string,
  context: { lead?: Record<string, unknown> | null } | null,
  payload: Record<string, unknown> = {},
): TriggerVerdict {
  const sameType = specs.filter((spec) => spec.type === eventType);
  if (sameType.length === 0) {
    return { matched: null, reason: `listens for ${describeTriggers(specs)}, not "${eventType}"` };
  }

  // An event may NAME the trigger it was raised for, and the scheduler does:
  // two `lead_idle` triggers with different idleDays sweep separately and emit
  // separately, and without this both events would be attributed to whichever
  // one happens to be first in the list — so one of the two configurations
  // would silently never be the reason anybody enrolled.
  //
  // Honoured only when THIS version actually has that id, so a name arriving
  // from anywhere else is ignored rather than able to suppress a match.
  const named = typeof payload.triggerId === "string" ? payload.triggerId : null;
  const candidates =
    named && sameType.some((spec) => spec.id === named)
      ? sameType.filter((spec) => spec.id === named)
      : sameType;

  const matched = candidates.find((spec) => triggerMatches(spec, context, payload));
  // ENROLS ONCE. `find`, not a loop over every match: two triggers can admit the
  // same event (a named one and a catch-all), and enrolling per match would
  // create a second run — or, under the idempotency key, a phantom "already
  // enrolled" refusal in the trace beside the real enrolment.
  if (!matched) return { matched: null, reason: "trigger filters did not match" };
  return { matched };
}
