import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Module, { createRequire } from "node:module";

import { decideInheritedTenant } from "../src/lib/tenant";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";

/**
 * A ROW THAT NAMES NO WORKSPACE IS A ROW ITS OWN WORKSPACE CANNOT READ BACK.
 *
 * The 2026-08-10 production audit counted 843 rows written in a fortnight with
 * `tenantId = NULL` — every one of them by a code path still running. The
 * mechanism is always the same and it is not subtle: `scopeArgs` in db.ts returns
 * its args UNTOUCHED unless `tenantEnforcing()`, and enforcement is off in every
 * environment, so "the guard stamps it" is a statement about the future. Anything
 * that leaned on the guard — or on `writeTenantId()`, or on
 * `activeTenantPredicate()`, both of which answer null while dormant — has been
 * writing NULL the whole time.
 *
 * This file covers the half of that list owned by this change: the journey trio
 * (JourneyRun, JourneyStepLog, JourneyEvent — 100% unowned, the signature of a
 * module never wired for tenancy), Conversation, CompetitorBrief, ResearchNote,
 * TestDriveBooking and Dashboard.
 *
 * Three layers, because each catches a different regression:
 *
 *   1. the ORDERING of the inheritance ladder, executed rather than described;
 *   2. BEHAVIOURAL runs of the two writers that are worth standing up — the
 *      conversation opener (a `basePrisma` write on a webhook, no session) and
 *      the journey enrolment (a `basePrisma` advisory-lock transaction) — against
 *      an in-memory client with NO guard and NO RLS, which is precisely today's
 *      production;
 *   3. SOURCE assertions on the remaining writers, comment-stripped so a comment
 *      that merely talks about stamping cannot satisfy them.
 */

/* ── 1. the ladder ─────────────────────────────────────────────────── */

const A = "tenant-a";
const B = "tenant-b";

test("the inheritance ladder: enforced scope, then the record, then the tick, then the founding tenant", () => {
  // Rung 1 wins outright. Under enforcement the scope is authoritative — the same
  // rule `stampCreate` follows when it spreads its own tenantId LAST.
  assert.equal(
    decideInheritedTenant({ enforcedTenantId: A, recordTenantId: B, ambientTenantId: B }),
    A,
    "an enforced scope must not be overridden by a row that disagrees with it",
  );

  // Rung 2 is the whole point of this change: while enforcement is dormant
  // `enforcedTenantId` is null, and the record being acted on is what knows.
  assert.equal(
    decideInheritedTenant({ enforcedTenantId: null, recordTenantId: B, ambientTenantId: A }),
    B,
    "with no enforced scope the record being acted on owns what descends from it",
  );

  // Rung 3: a cron tick binds a scope even on its dormant path
  // (runCronPerTenant), so a parentless write still has a real answer.
  assert.equal(
    decideInheritedTenant({ enforcedTenantId: null, recordTenantId: null, ambientTenantId: B }),
    B,
    "a parentless runtime write belongs to the slice being swept",
  );

  // Rung 4, and ONLY rung 4. Never null.
  assert.equal(
    decideInheritedTenant({ enforcedTenantId: null, recordTenantId: null, ambientTenantId: null }),
    DEFAULT_TENANT_ID,
  );
  assert.equal(decideInheritedTenant({ enforcedTenantId: null }), DEFAULT_TENANT_ID);
});

test("the ladder never yields null, undefined or an empty string", () => {
  for (const recordTenantId of [null, undefined]) {
    for (const ambientTenantId of [null, undefined]) {
      const answer = decideInheritedTenant({ enforcedTenantId: null, recordTenantId, ambientTenantId });
      assert.equal(typeof answer, "string");
      assert.ok(answer.length > 0, "a stamp of '' is as unowned as a stamp of NULL");
    }
  }
});

/* ── module interception, for the behavioural runs ─────────────────── */

/**
 * `conversations.ts` and `journeyEngineShared.ts` reach a live PrismaClient
 * through `./db` and `server-only` through `./tenantWrite`; `server-only` is not
 * installed (Next vendors it behind an RSC export condition). tsx compiles these
 * tests to CommonJS, so both are swapped by intercepting the module loader and
 * then requiring the REAL modules through it.
 *
 * Every swap is anchored on the REQUESTING file, so a fake client cannot leak
 * into a module that merely happens to import the same thing. `./tenantWrite`
 * and `./tenant` are deliberately NOT stubbed anywhere: they are the thing under
 * test.
 */
type Loader = (
  this: unknown,
  request: string,
  parent: { filename?: string } | undefined,
  isMain: boolean,
) => unknown;

/** Every row the fake clients were asked to create, in order. */
const created: Array<{ model: string; data: Record<string, unknown> }> = [];
/** Rows the fake `findUnique`/`findFirst` hands back, keyed by model. */
const rows: Record<string, Array<Record<string, unknown>>> = {};

function reset() {
  created.length = 0;
  for (const key of Object.keys(rows)) delete rows[key];
}

function fakeModel(name: string) {
  const find = (args: { where?: Record<string, unknown> } = {}) => {
    const where = args.where ?? {};
    const match = (rows[name] ?? []).find((row) =>
      Object.entries(where).every(([key, value]) =>
        value != null && typeof value === "object" ? true : row[key] === value,
      ),
    );
    return Promise.resolve(match ?? null);
  };
  return {
    findUnique: find,
    findFirst: find,
    create: (args: { data: Record<string, unknown> }) => {
      created.push({ model: name, data: args.data });
      return Promise.resolve({ id: `${name}-1`, status: args.data.status ?? "queued", ...args.data });
    },
  };
}

const fakeClient = new Proxy({} as Record<string, unknown>, {
  get(target, prop: string) {
    if (typeof prop !== "string" || prop.startsWith("$") || prop === "then") return undefined;
    if (!target[prop]) target[prop] = fakeModel(prop);
    return target[prop];
  },
});

const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
const from = (parent: { filename?: string } | undefined, file: string) =>
  (parent?.filename ?? "").replace(/\\/g, "/").endsWith(file);

loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only" || request === "client-only") return {};
  // `withTenantWrite` is the only thing in tenantWrite that touches basePrisma,
  // and nothing here calls it.
  if (from(parent, "src/lib/tenantWrite.ts") && request === "./db") return { basePrisma: {} };
  if (from(parent, "src/lib/conversations.ts") && request === "./db") {
    return { basePrisma: fakeClient, prisma: fakeClient };
  }
  if (from(parent, "src/lib/journeyEngineShared.ts")) {
    if (request === "./db") return { prisma: fakeClient };
    if (request === "./journeyContext") {
      return { loadJourneyContext: async () => ({ lead: { id: "lead-1" }, contact: null }) };
    }
    if (request === "./journeyTypes") {
      return {
        parseConditionGroup: () => null,
        evaluateConditions: () => true,
        parseJourneyDefinition: () => ({ startStepId: "step-1" }),
      };
    }
    if (request === "./journeyArbitration") {
      return {
        MAX_OPEN_RUNS_PER_ENTITY: 10,
        REFUSAL_REASONS: {},
        parseRunMode: () => "single",
        arbitrateEnrolment: async () => ({ action: "enrol" as const }),
        // The real one opens a basePrisma transaction under a per-(journey,
        // entity) advisory lock. What matters here is that it hands the body a
        // client the db.ts guard has never seen — which is what makes an explicit
        // stamp the only thing that can own the row.
        withEnrolmentLock: async (
          _journeyId: string,
          _entityType: string,
          _entityId: string,
          fn: (tx: unknown) => Promise<unknown>,
        ) => fn(fakeClient),
      };
    }
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const require_ = createRequire(import.meta.url);
const conversations = require_("../src/lib/conversations.ts") as typeof import("../src/lib/conversations");
const engineShared = require_("../src/lib/journeyEngineShared.ts") as typeof import("../src/lib/journeyEngineShared");
const { runInTenantScope } = require_("../src/lib/tenantScope.ts") as typeof import("../src/lib/tenantScope");

/* ── 2. behavioural: the two basePrisma writers ────────────────────── */

test("a conversation opened by an inbound message is owned by the customer it is about", async () => {
  reset();
  rows.contact = [{ id: "contact-1", tenantId: B }];

  // No session, no scope: a WhatsApp webhook, which is how conversations are
  // actually opened. Enforcement is dormant, so `writeTenantId()` is null and the
  // guard stamps nothing — and this write is on `basePrisma` anyway, which
  // bypasses the guard entirely.
  const resolved = await conversations.resolveConversationId({ contactId: "contact-1", type: "whatsapp" });
  assert.equal(resolved?.id, "conversation-1");

  const conversation = created.find((row) => row.model === "conversation");
  assert.ok(conversation, "the conversation must have been created");
  assert.equal(
    conversation.data.tenantId,
    B,
    "an unowned conversation is invisible at the flip to the workspace whose customer sent the message",
  );
});

test("the message's own owner wins over everything, so the composite FK holds", async () => {
  reset();
  // The contact says B. The Communication being written says A — under
  // enforcement that value is the guard's own stamp, and
  // `Communication(tenantId, conversationId) → Conversation(tenantId, id)` is
  // violated the moment the conversation disagrees with it.
  rows.contact = [{ id: "contact-1", tenantId: B }];
  await conversations.resolveConversationId({ contactId: "contact-1", type: "email", tenantId: A });

  const conversation = created.find((row) => row.model === "conversation");
  assert.equal(conversation?.data.tenantId, A, "the conversation must match the message that opened it");
});

test("a conversation for a legacy unowned customer stays unowned, because the FK says so", async () => {
  // This test previously asserted the opposite — that an unowned subject falls
  // back to the ambient scope "never to null". That was wrong, and the integration
  // suite proved it: `Conversation(tenantId, contactId) → Contact(tenantId, id)` is
  // a COMPOSITE foreign key, so a conversation claiming an owner its contact does
  // not have cannot be inserted at all. Postgres refuses with P2003 and the inbound
  // message is lost.
  //
  // Production is full of contacts with a NULL tenantId, so "never to null" was not
  // a safe default; it was a write that fails. The subject decides, null included,
  // and a later backfill claims the pair together — the only way they stay
  // consistent with each other.
  reset();
  rows.lead = [{ id: "lead-9", tenantId: null }];

  await runInTenantScope({ tenantId: B, system: false }, async () => {
    await conversations.resolveConversationId({ leadId: "lead-9", type: "messenger" });
  });

  const conversation = created.find((row) => row.model === "conversation");
  assert.equal(
    conversation?.data.tenantId,
    null,
    "an unowned subject must not have an owner invented for it — the composite FK rejects the row",
  );
});

// The ladder's rung 3 (`inheritedTenantId(null)` when there is NO subject) is
// deliberately not pinned here: `resolveConversationId` creates nothing when it
// has neither a contact nor a lead, so there is no row to assert on. I tried to
// pin it and the test failed for that reason rather than a tenancy one — better
// to say so than to assert a behaviour the function does not have.

test("an existing open thread is reused rather than re-created", async () => {
  reset();
  rows.contact = [{ id: "contact-1", tenantId: B }];
  rows.conversation = [{ id: "existing", channel: "whatsapp", contactId: "contact-1" }];

  const resolved = await conversations.resolveConversationId({ contactId: "contact-1", type: "whatsapp" });
  assert.equal(resolved?.id, "existing");
  assert.equal(created.length, 0, "the tenant lookup must not have turned a reuse into a create");
});

test("a journey run is owned by the journey it enrols into", async () => {
  reset();

  const outcome = await engineShared.enqueueJourneyRun({
    // Loaded by both real callers with an explicit `where: { tenantId }`, so this
    // is a fact about the workspace, not a guess.
    journey: { id: "journey-1", name: "Welcome", category: "marketing", runMode: "single", tenantId: B },
    version: { id: "version-1", version: 1, entryConditions: null, definition: {} },
    entityType: "lead",
    entityId: "lead-1",
    eventKey: "event-1",
    payload: {},
  });
  assert.equal(outcome.enrolled, true);

  const run = created.find((row) => row.model === "journeyRun");
  assert.ok(run, "the run must have been created");
  assert.equal(
    run.data.tenantId,
    B,
    "JourneyRun was 6 of 6 unowned on production; this is the write that did it",
  );
  assert.equal(run.data.journeyId, "journey-1");
});

test("an enforced scope still wins over the journey row", async () => {
  reset();
  const { __setTenantEnforcingForTests } =
    require_("../src/lib/tenantEnforcement.ts") as typeof import("../src/lib/tenantEnforcement");
  __setTenantEnforcingForTests(true);
  try {
    await runInTenantScope({ tenantId: A, system: false }, async () => {
      await engineShared.enqueueJourneyRun({
        journey: { id: "journey-1", name: "Welcome", category: "marketing", runMode: "single", tenantId: B },
        version: { id: "version-1", version: 1, entryConditions: null, definition: {} },
        entityType: "lead",
        entityId: "lead-1",
        eventKey: "event-2",
        payload: {},
      });
    });
  } finally {
    __setTenantEnforcingForTests(false);
  }

  const run = created.find((row) => row.model === "journeyRun");
  assert.equal(run?.data.tenantId, A, "under enforcement the scope is authoritative, not the fetched row");
});

/* ── 3. source assertions on the remaining writers ─────────────────── */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Comment-stripped, so prose about stamping cannot stand in for stamping. */
const shipped = (rel: string) =>
  readFileSync(path.join(root, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** The `create({ data: { … } })` payloads for one model, comments removed. */
function createPayloads(code: string, model: string): string[] {
  const found: string[] = [];
  const marker = new RegExp(`\\.${model}\\.(create|upsert)\\(`, "g");
  for (let hit = marker.exec(code); hit; hit = marker.exec(code)) {
    // Balanced-brace slice from the call, so a nested object cannot truncate it.
    let depth = 0;
    let end = hit.index;
    for (let i = hit.index + hit[0].length - 1; i < code.length; i += 1) {
      if (code[i] === "(") depth += 1;
      if (code[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    found.push(code.slice(hit.index, end + 1));
  }
  return found;
}

test("every writer this change owns names a tenant on the row it creates", () => {
  const cases: Array<{ file: string; model: string; expect: RegExp; count: number }> = [
    // Session paths — the acting workspace, resolved through the ONE shared
    // resolver. `writeTenantId()` here would be the flow-builder defect again:
    // null while dormant, so every workspace's row collapses onto the founding
    // tenant.
    {
      file: "src/app/actions/dashboardConfig.ts",
      model: "dashboard",
      expect: /tenantId: await actingTenantId\(\)/,
      count: 2,
    },
    {
      file: "src/app/actions/testDrives.ts",
      model: "testDriveBooking",
      expect: /tenantId: bookingTenantId/,
      count: 1,
    },
    // Not on the audit list — production holds no unowned rows for it — but the
    // identical defect in the same module, and the next one to be found.
    {
      file: "src/app/actions/dashboard.ts",
      model: "dashboardLayout",
      expect: /tenantId: await actingTenantId\(\)/,
      count: 1,
    },
    // Runtime paths — the record being acted on.
    {
      file: "src/lib/competitors.ts",
      model: "competitorBrief",
      expect: /tenantId: inheritedTenantId\(competitor\.tenantId\)/,
      count: 2,
    },
    {
      file: "src/lib/ai.ts",
      model: "researchNote",
      expect: /tenantId: inheritedTenantId\(lead\.tenantId\)/,
      count: 1,
    },
    {
      file: "src/app/actions/ai.ts",
      model: "researchNote",
      expect: /tenantId: inheritedTenantId\(subjectTenantId\)/,
      count: 1,
    },
    // The journey trio. JourneyEvent already stamped; the assertion is here so
    // the module cannot regress to two-out-of-three.
    {
      file: "src/lib/journeyEvents.ts",
      model: "journeyEvent",
      expect: /tenantId: journeyTenantId\(\)/,
      count: 1,
    },
    {
      file: "src/lib/journeyRuns.ts",
      model: "journeyStepLog",
      expect: /tenantId: args\.tenantId/,
      count: 1,
    },
  ];

  for (const { file, model, expect, count } of cases) {
    const payloads = createPayloads(shipped(file), model);
    assert.equal(payloads.length, count, `${file}: expected ${count} ${model} write(s), found ${payloads.length}`);
    for (const payload of payloads) {
      assert.match(payload, expect, `${file}: this ${model} write lands with a NULL tenant:\n${payload}`);
    }
  }
});

test("the step-log tenant comes from the run, and every trace site goes through the same door", () => {
  const code = shipped("src/lib/journeyRuns.ts");
  assert.match(
    code,
    /const logTenantId = inheritedTenantId\(run\.tenantId\)/,
    "the trace must inherit the run's owner, not the ambient scope",
  );
  // One bound logger, so a fourteenth trace site cannot be added without the
  // stamp — the shape that let all thirteen ship unowned in the first place.
  assert.equal(
    (code.match(/writeStepLog\(/g) ?? []).length,
    2,
    "writeStepLog must be reached only through its declaration and the bound updateStepLog",
  );
  assert.match(
    code,
    /const updateStepLog = \(args: Omit<StepLogArgs, "tenantId">\) =>\s*writeStepLog\(\{ \.\.\.args, tenantId: logTenantId \}\)/,
    "the bound logger is what supplies the stamp to all thirteen sites",
  );
  assert.ok(
    (code.match(/await updateStepLog\(\{?/g) ?? []).length >= 13,
    "every trace site must go through the bound logger",
  );
});

test("no writer in this change resolves a create stamp from writeTenantId() alone", () => {
  // The single most repeated mistake on the audit list: `writeTenantId()` is a
  // rollout-behaviour question, and its answer while dormant is null.
  for (const file of [
    "src/lib/conversations.ts",
    "src/lib/competitors.ts",
    "src/lib/ai.ts",
    "src/lib/journeyEngineShared.ts",
    "src/app/actions/ai.ts",
    "src/app/actions/testDrives.ts",
    "src/app/actions/dashboardConfig.ts",
  ]) {
    const code = shipped(file);
    assert.ok(
      !/tenantId: writeTenantId\(\)/.test(code),
      `${file}: writeTenantId() returns null while enforcement is dormant — this stamps NULL`,
    );
    assert.ok(
      !/tenantId: null/.test(code),
      `${file}: a NULL tenant is un-owned, never an owner to write`,
    );
  }
});

test("there is exactly one implementation of the acting-tenant rule", () => {
  // Two copies of a ladder is two places for it to drift. `builderTenantId` was
  // the first caller; it now delegates rather than re-deriving.
  const flowScope = shipped("src/lib/flowScope.ts");
  assert.match(flowScope, /return actingTenantId\(\)/);
  assert.ok(
    !/decide(?:Builder|Acting)Tenant\(/.test(flowScope),
    "flowScope must not re-derive the rule it now shares",
  );

  // WHAT THE PURE RULE IS CALLED IS NOT THE INVARIANT, AND MUST NOT BE PINNED
  // HERE. Four branches in the 2026-08-10 tenant wave each shipped this module:
  // this one delegates to `decideBuilderTenant` in ./flowTenantScope, which has
  // been on main since the flow-builder scoping work (#452) and is what the
  // reconciliation PR settled on as canonical; #457/#459/#430 each carried a
  // byte-identical `decideActingTenant` in ./actingTenantRule. Both bodies are
  // `enforced ?? session ?? founding` and were executed against the same 36-case
  // cross product, a 24-case enforcement x session matrix and 9 adversarial
  // inputs with zero divergence. So an assertion on the spelling would not
  // measure tenant safety at all — it would only decide which sibling branch
  // turns this suite red by landing first, in whichever order the add/add
  // conflict on this file happens to be resolved.
  //
  // What must hold under EITHER resolution is the shape: ONE delegation, to a rule
  // this module IMPORTS rather than re-derives, fed by BOTH rungs. A delegation
  // that dropped the session rung — the original defect — still fails here.
  const acting = shipped("src/lib/actingTenant.ts");
  assert.equal(
    (acting.match(/decide(?:Builder|Acting)Tenant\(\{/g) ?? []).length,
    1,
    "actingTenantId must resolve through exactly one pure rule, called exactly once",
  );
  assert.match(
    acting,
    /import \{ decide(?:Builder|Acting)Tenant \} from "\.\/(?:flowTenantScope|actingTenantRule)";/,
    "the rule must be imported — a copy defined here is the duplication this test exists to stop",
  );
  // BOTH RUNGS MUST STILL FEED THE RULE. Asserted on the values rather than on
  // one inline expression: they are now read into named consts so the resolver
  // can refuse when BOTH are empty, before the pure rule's `?? DEFAULT_TENANT_ID`
  // last rung can be taken. The original defect — a delegation that dropped the
  // session rung — still fails here, because the session read and its use as
  // `sessionTenantId` are both required.
  assert.match(acting, /writeTenantId\(\)/, "the enforced rung must still be read");
  assert.match(acting, /await getActiveTenantId\(\)/, "the session rung must still be read");
  assert.match(
    acting,
    /decide(?:Builder|Acting)Tenant\(\{ enforcedTenantId, sessionTenantId \}\)/,
    "both rungs must be handed to the pure rule",
  );
  // And the founding-tenant fallback must stay unreachable from here.
  assert.match(
    acting,
    /if \(!enforcedTenantId && !sessionTenantId\) \{[\s\S]*throw new TenantScopeError/,
    "an unresolvable session must refuse rather than fall through to the founding tenant",
  );
});
