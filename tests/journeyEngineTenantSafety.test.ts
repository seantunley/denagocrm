import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import Module, { createRequire } from "node:module";

import * as spy from "./stubs/prismaJourneyEngineSpy";

/**
 * THE JOURNEY ENGINE MUST NAME ITS OWN TENANT, IN EVERY MODE.
 *
 * `tenantEnforcing()` is `tenantMode() === "enforce"`, and TENANT_ENFORCEMENT is
 * unset — therefore "off" — in every environment nobody has explicitly flipped.
 * In that mode `scopeArgs` in db.ts returns its args UNTOUCHED by design, so a
 * query that carries no `tenantId` of its own is genuinely unscoped: the
 * scheduling sweep selects every workspace's active journeys, sweeps every
 * workspace's leads, contacts and vehicles, and emits events for them — which
 * the run phase turns into real email and WhatsApp to another tenant's
 * customers. A cross-tenant read is embarrassing; a cross-tenant SEND cannot be
 * taken back.
 *
 * These tests therefore run the SHIPPED functions against an in-memory client
 * that applies exactly the `where` the caller wrote and nothing more — no guard,
 * no RLS — which is precisely the situation with enforcement off. They assert on
 * the PREDICATE as well as the rows, because a query can return the right answer
 * for the wrong reason, and only the predicate shows the scoping.
 *
 * Both modes are exercised. Off, the founding tenant stands in (the same value
 * `runCronPerTenant` binds on its dormant path). On, the acting tenant is the
 * scope — and the enforcing case deliberately acts as the NON-founding tenant,
 * so a fix that hard-coded `DEFAULT_TENANT_ID` instead of following the scope
 * would fail here.
 */

/**
 * `journeyScheduling.ts` / `journeyEvents.ts` reach a live PrismaClient through
 * `./db`, and their tenant helper reaches `server-only`, so the unit runner
 * cannot load them as shipped. tsx compiles these tests to CommonJS, so both —
 * plus the heavy collaborators that are not under test here — are swapped by
 * intercepting the module loader and then requiring the real modules through it.
 * Every swap is anchored on the REQUESTING file, so a stub cannot leak into some
 * other module that happens to import the same thing.
 */
type Loader = (
  this: unknown,
  request: string,
  parent: { filename?: string } | undefined,
  isMain: boolean,
) => unknown;

/** What `enqueueJourneyRun` was asked to enrol, and with what run payload. */
const enrolments: Array<{
  journeyId: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
}> = [];
/** Every context load, so a cross-tenant entity read is visible even if nothing enrols. */
const contextLoads: Array<{ entityType: string; entityId: string; event: Record<string, unknown> }> = [];
/** Every audience resolution, and — the whole point — the tenant it was asked for. */
const audienceResolutions: Array<{ tenantId: unknown; channel: unknown }> = [];

function resetSpies() {
  enrolments.length = 0;
  contextLoads.length = 0;
  audienceResolutions.length = 0;
}

const engineShared = {
  getActiveVersion: (journey: { activeVersion: number | null; versions: Array<{ version: number }> }) =>
    journey.versions.find((version) => version.version === journey.activeVersion) ?? null,
  // Identity, so a dedupe key stays readable in a failure message. The engine
  // only needs it to be deterministic.
  hashJourneyKey: (value: string) => value,
  jsonObject: (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {},
  REFUSAL_REASONS: {
    entity_missing: "the lead or contact no longer exists",
    entry_conditions: "entry conditions did not match",
    no_steps: "the published version has no first step",
    cap_reached: "already at the per-person cap",
    single_open: "a run is already open",
    duplicate_event: "already enrolled for this event",
  },
  enqueueJourneyRun: async (args: {
    journey: { id: string };
    entityType: string;
    entityId: string;
    payload: Record<string, unknown>;
  }) => {
    enrolments.push({
      journeyId: args.journey.id,
      entityType: args.entityType,
      entityId: args.entityId,
      payload: args.payload,
    });
    return { enrolled: true as const, runId: `run-${enrolments.length}`, status: "queued" as const };
  },
};

const journeyContext = {
  // Modelled on the REAL loadJourneyContext, which looks an entity up by id
  // ALONE — no tenant predicate. That is deliberate: the protection has to come
  // from the caller resolving the entity within its own tenant first, so this
  // stub must stay as permissive as the thing it stands in for.
  loadJourneyContext: async (entityType: string, entityId: string, event: Record<string, unknown> = {}) => {
    contextLoads.push({ entityType, entityId, event });
    const row = spy.rows(entityType === "lead" ? "lead" : "contact").find((r) => r.id === entityId);
    if (!row) return null;
    return {
      event,
      lead: entityType === "lead" ? { id: row.id, stageId: row.stageId ?? null } : null,
      contact: entityType === "contact" ? { id: row.id } : null,
    };
  },
};

const campaigns = {
  // Also modelled on the real one: it returns the contacts of whatever tenant it
  // is TOLD. Handing it a tenant read off a looked-up segment row is the entire
  // cross-tenant read in blocker 2, and a stub that ignored the argument would
  // make that bug untestable.
  resolveContacts: async (tenantId: string, _criteria: unknown, channel: string) => {
    audienceResolutions.push({ tenantId, channel });
    return spy.rows("contact").filter((contact) => contact.tenantId === tenantId).map((contact) => ({ id: contact.id }));
  },
};

const leadIdle = {
  // The engine's own row-staleness filter is what these tests exercise; the
  // "has anything else touched this lead" check is a separate unit with its own
  // coverage, so it always says yes here.
  leadHasGoneQuiet: async () => true,
  lastEngagementAt: async () => null,
};

const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only" || request === "client-only") return {};
  const from = parent?.filename ?? "";
  const engine = from.endsWith("journeyEvents.ts") || from.endsWith("journeyScheduling.ts");
  if (request === "./db") {
    if (engine) return { prisma: spy.prisma };
    // tenantWrite only needs `basePrisma` for withTenantWrite, which nothing
    // here calls — but importing it would build a real client.
    if (from.endsWith("tenantWrite.ts")) return { basePrisma: {} };
  }
  if (engine && request === "./journeyEngineShared") return engineShared;
  if (from.endsWith("journeyEvents.ts") && request === "./journeyContext") return journeyContext;
  if (from.endsWith("journeyScheduling.ts") && request === "./campaigns") return campaigns;
  if (from.endsWith("journeyScheduling.ts") && request === "./leadIdle") return leadIdle;
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const require_ = createRequire(import.meta.url);
const scheduling = require_("../src/lib/journeyScheduling.ts") as typeof import("../src/lib/journeyScheduling");
const events = require_("../src/lib/journeyEvents.ts") as typeof import("../src/lib/journeyEvents");
const tenantScope = require_("../src/lib/tenantScope.ts") as typeof import("../src/lib/tenantScope");
const enforcement = require_("../src/lib/tenantEnforcement.ts") as typeof import("../src/lib/tenantEnforcement");
const { DEFAULT_TENANT_ID } = require_("../src/lib/tenant.ts") as typeof import("../src/lib/tenant");
void fileURLToPath;

/** The founding tenant — what a dormant slice resolves to, and who owns the legacy rows. */
const HOME = DEFAULT_TENANT_ID;
/** Any other workspace on the platform. Never this slice's tenant. */
const OTHER = "tenant_intruder";

const HOUR = 60 * 60 * 1000;
const LONG_AGO = new Date(Date.now() - 400 * 24 * HOUR);
const EARLIER = new Date(Date.now() - HOUR);

/**
 * Run `fn` the way `runCronPerTenant` runs a journey slice.
 *
 * Off, that runner binds the FOUNDING tenant's scope and executes once; on, it
 * binds each active tenant in turn. Both are reproduced exactly, because the
 * claim under test is that the engine behaves the same either way.
 */
async function asSlice<T>(mode: { enforcing: boolean; acting: string }, fn: () => Promise<T>): Promise<T> {
  enforcement.__setTenantEnforcingForTests(mode.enforcing);
  try {
    return await tenantScope.runInTenantScope({ tenantId: mode.acting, system: false }, fn);
  } finally {
    enforcement.__setTenantEnforcingForTests(null);
  }
}

const MODES = [
  // Off is listed first because it is the DEFAULT and the rollback mode — the
  // one where the guard scopes nothing and these predicates are the only
  // boundary there is.
  { label: "enforcement OFF (guard scopes nothing)", enforcing: false, acting: HOME, foreign: OTHER },
  // Acting as the NON-founding tenant on purpose: a fix that reached for
  // DEFAULT_TENANT_ID rather than the slice's scope passes the off case and
  // fails this one.
  { label: "enforcement ON", enforcing: true, acting: OTHER, foreign: HOME },
];

/** Assert a predicate pins the tenant by STRICT EQUALITY, never a filter that could admit NULL. */
function assertStrictTenant(where: unknown, tenantId: string, what: string) {
  const value = (where as Record<string, unknown> | undefined)?.tenantId;
  assert.equal(
    typeof value,
    "string",
    `${what}: tenantId must be a strict equality on a concrete id — a filter object (or an absent predicate) can match a NULL-tenant, un-owned row`,
  );
  assert.equal(value, tenantId, `${what}: must be scoped to the slice's own tenant`);
}

/** Two workspaces, each with one active journey on a published version. */
function seedTwoTenants(triggersFor: (tenantId: string) => unknown[]) {
  return {
    journey: [
      { id: "j-home", tenantId: HOME, name: "Home journey", category: "automation", status: "active", runMode: "single", activeVersion: 1 },
      { id: "j-other", tenantId: OTHER, name: "Other journey", category: "automation", status: "active", runMode: "single", activeVersion: 1 },
    ],
    journeyVersion: [
      { id: "v-home", tenantId: HOME, journeyId: "j-home", version: 1, state: "published", triggers: triggersFor(HOME), entryConditions: null, definition: {} },
      { id: "v-other", tenantId: OTHER, journeyId: "j-other", version: 1, state: "published", triggers: triggersFor(OTHER), entryConditions: null, definition: {} },
    ],
    lead: [
      { id: "lead-home", tenantId: HOME, status: "open", stageId: "stage-home", contactId: "c-home", updatedAt: LONG_AGO },
      { id: "lead-other", tenantId: OTHER, status: "open", stageId: "stage-other", contactId: "c-other", updatedAt: LONG_AGO },
    ],
    contact: [
      { id: "c-home", tenantId: HOME, marketingOptOut: false },
      { id: "c-other", tenantId: OTHER, marketingOptOut: false },
    ],
  };
}

// ── BLOCKER 2 — the scheduling sweep ────────────────────────────────────────

for (const mode of MODES) {
  test(`scheduling sweep: another tenant's active journey is never selected or enrolled — ${mode.label}`, async () => {
    resetSpies();
    spy.reset(seedTwoTenants(() => [{ type: "lead_idle", config: { idleDays: 2 } }]));

    const created = await asSlice(mode, () => scheduling.runScheduledJourneyEnrollments());

    // 1. THE PREDICATE. Rows alone would not distinguish a scoped query from a
    // lucky one, and this is the assertion that fails against a sweep leaning on
    // the guard: with enforcement off there is no tenantId in the where at all.
    const journeyReads = spy.callsFor("journey", "findMany");
    assert.equal(journeyReads.length, 1, "the sweep asks for active journeys once");
    assertStrictTenant(journeyReads[0].args.where, mode.acting, "journey.findMany");
    const nested = (journeyReads[0].args.include as { versions?: { where?: unknown } } | undefined)?.versions;
    assertStrictTenant(
      nested?.where,
      mode.acting,
      "the nested published-version read (an include is never touched by the guard, in either mode)",
    );

    const leadReads = spy.callsFor("lead", "findMany");
    assert.ok(leadReads.length > 0, "the idle sweep must actually have run, or this proves nothing");
    for (const call of leadReads) assertStrictTenant(call.args.where, mode.acting, "lead.findMany");

    // 2. THE EFFECT. Exactly one journey — this tenant's — enrolled exactly one
    // lead, and every event written is stamped with the acting tenant rather
    // than landing un-owned.
    assert.equal(created, 1, "one idle lead in this tenant, so one enrolment");
    const emitted = spy.rows("journeyEvent");
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].tenantId, mode.acting, "an emitted event must carry the acting tenant, not NULL");
    assert.equal(emitted[0].journeyId, mode.acting === HOME ? "j-home" : "j-other");
    assert.equal(emitted[0].entityId, mode.acting === HOME ? "lead-home" : "lead-other");

    // 3. NOTHING OF THE OTHER TENANT'S, ANYWHERE.
    const foreignJourney = mode.foreign === HOME ? "j-home" : "j-other";
    const foreignLead = mode.foreign === HOME ? "lead-home" : "lead-other";
    for (const row of spy.rows("journeyEvent")) {
      assert.notEqual(row.journeyId, foreignJourney, "the other tenant's journey must never enrol anybody");
      assert.notEqual(row.entityId, foreignLead, "the other tenant's lead must never be enrolled");
    }
  });
}

test("enrollJourneyNow refuses another tenant's journey id rather than running it", async () => {
  resetSpies();
  spy.reset(seedTwoTenants(() => [{ type: "lead_idle", config: { idleDays: 2 } }]));

  // Reachable from a server action with an id out of the request. Scoped by
  // (id, tenantId), a foreign id does not resolve at all — so it is refused for
  // the same reason a deleted one is, and the refusal leaks nothing about
  // whether that journey exists.
  await assert.rejects(
    () => asSlice(MODES[0], () => scheduling.enrollJourneyNow("j-other")),
    /must be active/i,
    "another tenant's journey must not be enrollable by id",
  );
  const reads = [...spy.callsFor("journey", "findFirst"), ...spy.callsFor("journey", "findUnique")];
  assert.equal(reads.length, 1, "the journey is looked up once");
  assertStrictTenant(reads[0].args.where, HOME, "enrollJourneyNow journey lookup");
  assert.equal(spy.rows("journeyEvent").length, 0, "nothing may be emitted for a journey we do not own");
});

// ── BLOCKER 2 — the forged segmentId, and the tenant read off a looked-up row ──

for (const mode of [
  { label: "enforcement OFF (guard scopes nothing)", enforcing: false, acting: HOME, foreign: OTHER },
  { label: "enforcement ON", enforcing: true, acting: HOME, foreign: OTHER },
]) {
  test(`contact_segment: a segmentId belonging to another tenant resolves to nothing — ${mode.label}`, async () => {
    resetSpies();
    const seed = seedTwoTenants(() => [{ type: "contact_segment", config: { segmentId: "seg-other" } }]);
    spy.reset({
      ...seed,
      // Only the HOME journey is active here, so anything that happens is
      // unambiguously this slice reaching across — not the other tenant's own
      // journey doing its job.
      journey: seed.journey.filter((journey) => journey.id === "j-home"),
      journeyVersion: seed.journeyVersion.filter((version) => version.id === "v-home"),
      segment: [
        { id: "seg-other", tenantId: OTHER, name: "Their customers", criteria: JSON.stringify({}) },
        { id: "seg-home", tenantId: HOME, name: "Our customers", criteria: JSON.stringify({}) },
      ],
    });

    const created = await asSlice(mode, () => scheduling.runScheduledJourneyEnrollments());

    // The lookup is scoped, so the forged id matches no row — there is nothing
    // to read a tenant off, which is stronger than reading one and checking it.
    const lookups = [...spy.callsFor("segment", "findFirst"), ...spy.callsFor("segment", "findUnique")];
    assert.equal(lookups.length, 1, "the segment is looked up once");
    assert.equal((lookups[0].args.where as Record<string, unknown>).id, "seg-other");
    assertStrictTenant(lookups[0].args.where, HOME, "segment lookup");

    // THE FINDING, stated as an assertion: `resolveContacts(segment.tenantId, …)`
    // takes the ACTING tenant from the row it just fetched, so a forged id makes
    // the sweep fetch — and enrol, and ultimately message — the other
    // workspace's contacts.
    assert.deepEqual(audienceResolutions, [], "no audience may be resolved for a segment we do not own");
    assert.equal(created, 0);
    assert.equal(spy.rows("journeyEvent").length, 0, "nothing may be emitted from a foreign segment");
  });
}

test("contact_segment: our own segment resolves the audience for the SLICE's tenant", async () => {
  resetSpies();
  const seed = seedTwoTenants(() => [{ type: "contact_segment", config: { segmentId: "seg-home" } }]);
  spy.reset({
    ...seed,
    journey: seed.journey.filter((journey) => journey.id === "j-home"),
    journeyVersion: seed.journeyVersion.filter((version) => version.id === "v-home"),
    segment: [
      { id: "seg-home", tenantId: HOME, name: "Our customers", criteria: JSON.stringify({}) },
      { id: "seg-other", tenantId: OTHER, name: "Their customers", criteria: JSON.stringify({}) },
    ],
  });

  const created = await asSlice(MODES[0], () => scheduling.runScheduledJourneyEnrollments());

  // The positive control. Scoping is only worth anything if the legitimate path
  // still works — and the tenant handed to resolveContacts must be the slice's
  // own, which happens to equal the segment's here and must NOT be sourced from
  // it.
  assert.equal(audienceResolutions.length, 1);
  assert.equal(audienceResolutions[0].tenantId, HOME);
  assert.equal(created, 1);
  const emitted = spy.rows("journeyEvent");
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].entityId, "c-home");
  assert.equal(emitted[0].tenantId, HOME);
});

// ── BLOCKER 2 — the event pass ──────────────────────────────────────────────

function pendingEvent(id: string, tenantId: string, entityId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    tenantId,
    journeyId: null,
    type: "lead_created",
    entityType: "lead",
    entityId,
    payload: {},
    status: "pending",
    attempts: 0,
    availableAt: EARLIER,
    createdAt: EARLIER,
    dedupeKey: `key-${id}`,
    ...overrides,
  };
}

for (const mode of MODES) {
  test(`event pass: another tenant's pending event is never drained, claimed or settled — ${mode.label}`, async () => {
    resetSpies();
    spy.reset({
      ...seedTwoTenants(() => [{ type: "lead_created", config: {} }]),
      journeyEvent: [
        pendingEvent("ev-home", HOME, "lead-home"),
        pendingEvent("ev-other", OTHER, "lead-other"),
      ],
    });

    const result = await asSlice(mode, () => events.processJourneyEvents(50));

    const drains = spy.callsFor("journeyEvent", "findMany");
    assert.equal(drains.length, 1);
    assertStrictTenant(drains[0].args.where, mode.acting, "the pending-event drain");
    const journeyReads = spy.callsFor("journey", "findMany");
    assert.equal(journeyReads.length, 1, "one event, one journey lookup");
    assertStrictTenant(journeyReads[0].args.where, mode.acting, "journey.findMany during matching");

    assert.equal(result.processed, 1, "only this tenant's event is in the batch");
    assert.equal(result.enrolled, 1);

    // The CLAIM is a write. Unscoped, one slice takes another workspace's event
    // off the queue, increments its attempts and settles it — so that workspace
    // silently loses the enrolment and never learns why.
    const idFor = (tenantId: string) => (tenantId === HOME ? "ev-home" : "ev-other");
    const foreign = spy.rows("journeyEvent").find((row) => row.id === idFor(mode.foreign))!;
    assert.equal(foreign.status, "pending", "the other tenant's event must be left exactly where it was");
    assert.equal(foreign.attempts, 0, "…and never even claimed");
    const mine = spy.rows("journeyEvent").find((row) => row.id === idFor(mode.acting))!;
    assert.equal(mine.status, "processed", "…while our own is drained and settled as usual");
    assert.equal(mine.attempts, 1);

    assert.equal(enrolments.length, 1);
    assert.equal(enrolments[0].journeyId, mode.acting === HOME ? "j-home" : "j-other");
    const foreignEntity = mode.foreign === HOME ? "lead-home" : "lead-other";
    assert.ok(
      contextLoads.every((load) => load.entityId !== foreignEntity),
      "no context may be built from another tenant's lead — that record's name, email and phone become the message",
    );
  });
}

test("event pass: an entityId belonging to another tenant never becomes a run context", async () => {
  resetSpies();
  spy.reset({
    ...seedTwoTenants(() => [{ type: "lead_created", config: {} }]),
    // Our own event row, pointing at THEIR lead. loadJourneyContext resolves an
    // entity by id alone, so without a tenant-scoped resolution first this is a
    // straight cross-tenant read of the record the messages are rendered from.
    journeyEvent: [pendingEvent("ev-home", HOME, "lead-other")],
  });

  const result = await asSlice(MODES[0], () => events.processJourneyEvents(50));

  assert.equal(result.enrolled, 0, "a foreign entity must enrol nobody");
  assert.deepEqual(contextLoads, [], "the entity must be resolved within the tenant BEFORE its context is loaded");
  const ownership = [...spy.callsFor("lead", "findFirst"), ...spy.callsFor("lead", "findUnique")];
  assert.equal(ownership.length, 1, "exactly one scoped ownership question");
  assert.equal((ownership[0].args.where as Record<string, unknown>).id, "lead-other");
  assertStrictTenant(ownership[0].args.where, HOME, "the entity ownership lookup");
});

// ── BLOCKER 4 — event.triggerId is the AUTHOR's, not the producer's ─────────

/** One active journey in HOME whose published version lists `triggers`. */
function oneJourneyListening(triggers: unknown[], eventType: string, payload: Record<string, unknown>) {
  return {
    journey: [
      { id: "j-home", tenantId: HOME, name: "Home journey", category: "automation", status: "active", runMode: "single", activeVersion: 1 },
    ],
    journeyVersion: [
      { id: "v-home", tenantId: HOME, journeyId: "j-home", version: 1, state: "published", triggers, entryConditions: null, definition: {} },
    ],
    lead: [{ id: "lead-home", tenantId: HOME, status: "open", stageId: "stage-home", contactId: "c-home", updatedAt: LONG_AGO }],
    contact: [{ id: "c-home", tenantId: HOME, marketingOptOut: false }],
    journeyEvent: [pendingEvent("ev-home", HOME, "lead-home", { type: eventType, payload })],
  };
}

test("an incoming payload.triggerId does NOT survive into the run context when the matched trigger is unnamed", async () => {
  resetSpies();
  // The version lists ONE trigger and the author gave it no id — so there is no
  // trigger name in this journey for a condition to legitimately branch on.
  spy.reset(oneJourneyListening([{ type: "lead_created", config: {} }], "lead_created", {
    triggerId: "forged-by-the-producer",
    note: "ordinary payload data",
  }));

  await asSlice(MODES[0], () => events.processJourneyEvents(50));

  assert.equal(enrolments.length, 1, "the event still matches — this is about the payload, not the match");
  const run = enrolments[0].payload;
  assert.equal(
    "triggerId" in run,
    false,
    "an unnamed match must publish NO event.triggerId — otherwise a step can branch on a name whoever raised the event chose",
  );
  assert.equal(run.note, "ordinary payload data", "the rest of the payload is untouched");
  assert.equal(run.type, "lead_created");

  // The context the matcher and the entry conditions see must be clean too, not
  // just the run payload: the bag handed to loadJourneyContext IS `event` in the
  // journey context.
  assert.equal(contextLoads.length, 1);
  assert.equal(
    "triggerId" in contextLoads[0].event,
    false,
    "the context bag must never carry the producer's trigger name either",
  );
});

test("event.triggerId comes from verdict.matched.id when the author DID name the matched trigger", async () => {
  resetSpies();
  // Two triggers of the same type — the case that forces ids to exist at all.
  // The event names "fast", which must still select between them: the incoming
  // value is an INTERNAL selection, and dropping it entirely would attribute
  // every idle sweep to whichever trigger happens to be first in the list.
  spy.reset(
    oneJourneyListening(
      [
        { id: "slow", type: "lead_idle", config: {} },
        { id: "fast", type: "lead_idle", config: {} },
      ],
      "lead_idle",
      { triggerId: "fast" },
    ),
  );

  await asSlice(MODES[0], () => events.processJourneyEvents(50));

  assert.equal(enrolments.length, 1);
  assert.equal(
    enrolments[0].payload.triggerId,
    "fast",
    "the named match publishes its own id — and 'slow' here would mean the internal selection was thrown away with the payload key",
  );
  assert.equal(contextLoads.length, 1);
  assert.equal(
    "triggerId" in contextLoads[0].event,
    false,
    "the selection reaches the MATCHER, not the run context — the context gets the author's id, and only after a match",
  );
});

test("a triggerId naming nothing on this version is ignored, and the author's id is published instead", async () => {
  resetSpies();
  spy.reset(
    oneJourneyListening([{ id: "real", type: "lead_created", config: {} }], "lead_created", {
      triggerId: "ghost",
    }),
  );

  await asSlice(MODES[0], () => events.processJourneyEvents(50));

  assert.equal(enrolments.length, 1, "an unrecognised name must not suppress the match");
  assert.equal(enrolments[0].payload.triggerId, "real", "the published id is the one the AUTHOR gave the matched trigger");
  assert.equal(contextLoads.length, 1);
  assert.equal("triggerId" in contextLoads[0].event, false, "'ghost' must never reach the context");
});

// ── The shape of the fix, so it cannot be quietly undone ────────────────────

test("the engine resolves ONE tenant per slice, and never reads it off a fetched row", async () => {
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const shipped = (rel: string) =>
    readFileSync(path.join(root, rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  for (const file of ["src/lib/journeyScheduling.ts", "src/lib/journeyEvents.ts"]) {
    const code = shipped(file);
    assert.match(code, /journeyTenantId\(\)/, `${file} must resolve its tenant through the shared helper`);
    // The exact shape of the original hole: an acting tenant taken from a row
    // the query just returned. Any `<row>.tenantId` passed onward is that bug.
    assert.ok(
      !/resolveContacts\(\s*\w+\.tenantId/.test(code),
      `${file}: the audience tenant must be the slice's own, never one read off a looked-up row`,
    );
  }

  // Strict equality only. `IS NOT DISTINCT FROM`, an OR-null, or a nullable
  // filter object would all match un-owned rows and re-open the hole the moment
  // enforcement went back to off.
  const helper = shipped("src/lib/journeyTenant.ts");
  assert.match(helper, /writeTenantId\(\) \?\? DEFAULT_TENANT_ID/, "the founding tenant stands in when GLOBAL, and it throws when closed");
  for (const file of ["src/lib/journeyScheduling.ts", "src/lib/journeyEvents.ts", "src/lib/journeyTenant.ts"]) {
    const code = shipped(file);
    assert.ok(!/IS NOT DISTINCT FROM/i.test(code), `${file}: NULL-tolerant tenant matching is never correct here`);
    assert.ok(!/tenantId:\s*null/.test(code), `${file}: a NULL tenant is un-owned, not a tenant to query for`);
  }
});
